// --- FIREBASE + FIRESTORE ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import {
    getFirestore, doc, collection, addDoc, deleteDoc, query, where, runTransaction,
    setDoc as fsSetDoc,
    getDoc as fsGetDoc,
    updateDoc as fsUpdateDoc,
    onSnapshot as fsOnSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
// --- CONFIGURATION ---
import { firebaseConfig, geminiApiKey } from './config.js';

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Environment Variables
const apiKey = geminiApiKey; 
const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;


// Game State Globals
window.isOnlineMode = false;
window.currentLobbyCode = null;
window.isHost = false;
window.gameState = {
    players: [], civilianWord: "", imposterWord: "", currentPlayerIndex: 0, currentRound: 1, startingPlayerUid: null, status: 'lobby'
};

let currentUser = { uid: sessionStorage.getItem('wi_uid') || 'user_' + Math.random().toString(36).substr(2, 9) };
sessionStorage.setItem('wi_uid', currentUser.uid);

let unsubscribeLobby = null;

// Signaling listener cleanup
let unsubscribeSignaling = null;
let heartbeatInterval = null;

// --- FIRESTORE WRAPPERS (same interface as the old mock) ---
const setDoc = async (ref, data) => {
    await fsSetDoc(ref, data);
};

const getDoc = async (ref) => {
    const snap = await fsGetDoc(ref);
    return { exists: () => snap.exists(), data: () => snap.data() };
};

const updateDoc = async (ref, data) => {
    await fsUpdateDoc(ref, data);
};

const onSnapshot = (ref, callback) => {
    return fsOnSnapshot(ref, (snap) => {
        callback({ exists: () => snap.exists(), data: () => snap.data() });
    });
};

// --- CORE UI ---
window.showScreen = (screenId, pushHistory = true) => {
    ['mode-screen', 'setup-screen', 'online-setup-screen', 'online-lobby-screen', 'theme-screen', 'pass-screen', 'game-active-screen', 'game-over-screen'].forEach(id => {
        const el = document.getElementById(id);
        if (id === screenId) { el.classList.remove('hidden'); el.classList.add('flex'); }
        else { el.classList.add('hidden'); el.classList.remove('flex'); }
    });

    if (pushHistory) {
        history.pushState({ screenId: screenId }, "", `#${screenId}`);
    }
};

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.screenId) {
        window.showScreen(e.state.screenId, false);
    } else {
        window.showScreen('mode-screen', false);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    if (!history.state) {
        history.replaceState({ screenId: 'mode-screen' }, "", "#mode-screen");
    }
});

window.resetGame = async () => {
    // Graceful leave for Online Mode
    if (window.isOnlineMode && window.currentLobbyCode) {
        const lobbyRef = getLobbyRef(window.currentLobbyCode);
        try {
            await runTransaction(db, async (transaction) => {
                const lobbyDoc = await transaction.get(lobbyRef);
                if (!lobbyDoc.exists()) return;
                
                const data = lobbyDoc.data();
                const players = data.players.filter(p => p.uid !== currentUser.uid);
                
                if (players.length === 0) {
                    // No one left, delete the lobby entirely
                    transaction.delete(lobbyRef);
                } else {
                    let nextHostUid = data.hostUid;
                    // If I am host, pass it to the first available player
                    if (data.hostUid === currentUser.uid) {
                        nextHostUid = players[0].uid;
                    }
                    
                    transaction.update(lobbyRef, { 
                        players: players, 
                        hostUid: nextHostUid 
                    });
                }
            });

        } catch (e) {
            console.error("Error during graceful leave:", e);
        }
    }

    window.isOnlineMode = false;
    window.currentLobbyCode = null;
    window.isHost = false;
    if (unsubscribeLobby) { unsubscribeLobby(); unsubscribeLobby = null; }
    if (unsubscribeSignaling) { unsubscribeSignaling(); unsubscribeSignaling = null; }
    stopHeartbeat();
    if (window.leaveVoiceChat) window.leaveVoiceChat();
    window.gameState = { players: [], civilianWord: "", imposterWord: "", currentPlayerIndex: 0, currentRound: 1, status: 'lobby' };
    window.showScreen('mode-screen');
};



// --- WEBRTC VOICE CORE ---
window.localAudioStream = null;
window.peers = {}; // { uid: RTCPeerConnection }
window.voiceMode = 'off'; // 'off', 'live', 'listen'

// --- FIRESTORE SIGNALING ---
async function sendSignal(targetUid, data) {
    if (!window.currentLobbyCode) return;
    console.log(`[WI-VOICE] Sending signal to ${targetUid}:`, data.type);
    try {
        const signalingRef = collection(db, 'lobbies', window.currentLobbyCode, 'signaling');
        await addDoc(signalingRef, {
            ...data,
            senderUid: currentUser.uid,
            targetUid: targetUid,
            timestamp: Date.now()
        });
    } catch (err) {
        console.error("[WI-VOICE] Error sending signal (Check Firebase Rules):", err);
    }
}


function setupSignalingListener() {
    if (unsubscribeSignaling) unsubscribeSignaling();
    console.log("[WI-VOICE] Signaling listener active for UID:", currentUser.uid);
    const signalingRef = collection(db, 'lobbies', window.currentLobbyCode, 'signaling');
    const q = query(signalingRef, where('targetUid', '==', currentUser.uid));

    unsubscribeSignaling = fsOnSnapshot(q, async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const signalId = change.doc.id;
                console.log(`[WI-VOICE] Received signal: ${data.type} from ${data.senderUid}`);

                try {
                    if (data.type === 'webrtc_offer') {
                        await handleReceiveOffer(data);
                    } else if (data.type === 'webrtc_answer') {
                        await handleReceiveAnswer(data);
                    } else if (data.type === 'webrtc_ice') {
                        await handleReceiveIce(data);
                    } else if (data.type === 'voice_join') {
                        if (window.voiceMode !== 'off' && data.senderUid !== currentUser.uid) {
                            if (window.gameState.players.find(p => p.uid === data.senderUid)) {
                                console.log("[WI-VOICE] Toggling peer connection to new joiner:", data.senderUid);
                                await initiatePeerConnection(data.senderUid);
                            }
                        }
                    }
                    
                    // Cleanup: Delete signal document after processing
                    await deleteDoc(doc(db, 'lobbies', window.currentLobbyCode, 'signaling', signalId));
                } catch (err) {
                    console.error("[WI-VOICE] Error processing signal:", err);
                }
            }
        });
    }, (err) => {
        console.error("[WI-VOICE] Signaling snapshot error (Check Firebase Rules):", err);
    });
}


async function createPeerConnection(targetUid) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    window.peers[targetUid] = pc;

    if (window.localAudioStream && window.voiceMode !== 'listen') {
        window.localAudioStream.getTracks().forEach(track => pc.addTrack(track, window.localAudioStream));
    } else {
        pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal(targetUid, { type: 'webrtc_ice', candidate: JSON.stringify(event.candidate) });
        }
    };

    pc.ontrack = (event) => {
        let audioEl = document.getElementById('audio_remote_' + targetUid);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = 'audio_remote_' + targetUid;
            audioEl.autoplay = true;
            document.body.appendChild(audioEl);
        }
        audioEl.srcObject = event.streams[0];
    };
    return pc;
}

async function initiatePeerConnection(targetUid) {
    const pc = await createPeerConnection(targetUid);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(targetUid, { type: 'webrtc_offer', sdp: JSON.stringify(pc.localDescription) });
}

async function handleReceiveOffer(data) {
    if (window.voiceMode === 'off') return; 
    const pc = await createPeerConnection(data.senderUid);
    await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.sdp)));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(data.senderUid, { type: 'webrtc_answer', sdp: JSON.stringify(pc.localDescription) });
}

async function handleReceiveAnswer(data) {
    const pc = window.peers[data.senderUid];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.sdp)));
}

async function handleReceiveIce(data) {
    const pc = window.peers[data.senderUid];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate)));
}


window.changeVoiceMode = async () => {
    const select = document.getElementById('voice-mode');
    const mode = select.value;

    if (mode === 'off') {
        window.leaveVoiceChat();
        return;
    }

    // Switching live -> listen or vice versa: restart the connection
    window.leaveVoiceChat();
    window.voiceMode = mode;

    try {
        if (mode === 'live') {
            window.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        updateVoiceSelectUI(mode, select);
        
        // Broadcast join to all other players in the lobby
        window.gameState.players.forEach(p => {
            if (p.uid !== currentUser.uid) {
                sendSignal(p.uid, { type: 'voice_join' });
            }
        });

    } catch (e) {
        alert("Microphone access denied. Reverting to Disconnected.");
        window.leaveVoiceChat();
    }
};

function updateVoiceSelectUI(mode, select) {
    select.value = mode;
    let classes = "appearance-none text-white font-display font-bold uppercase tracking-wider px-4 py-3 rounded-lg outline-none cursor-pointer transition-colors shadow-lg shadow-black/20 focus:ring-2 pr-10 ring-2 ";
    if (mode === 'live') classes += "bg-green-600 ring-green-400";
    else if (mode === 'listen') classes += "bg-blue-600 ring-blue-400";
    select.className = classes;
}

window.leaveVoiceChat = () => {
    if (window.localAudioStream) {
        window.localAudioStream.getTracks().forEach(t => t.stop());
        window.localAudioStream = null;
    }
    Object.values(window.peers).forEach(pc => pc.close());
    window.peers = {};
    document.querySelectorAll('audio[id^="audio_remote_"]').forEach(el => el.remove());
    window.voiceMode = 'off';

    const select = document.getElementById('voice-mode');
    if (select) {
        select.value = 'off';
        select.className = "appearance-none bg-gray-700 text-white font-display font-bold uppercase tracking-wider px-4 py-3 rounded-lg outline-none cursor-pointer hover:bg-gray-600 transition-colors shadow-lg shadow-black/20 focus:ring-2 focus:ring-blue-500 pr-10";
    }
};

// --- ONLINE MULTIPLAYER LOGIC ---
function getLobbyRef(code) {
    return doc(db, 'lobbies', code);
}

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

window.hostOnlineGame = async () => {
    const errorMsg = document.getElementById('online-error-msg');
    if (!currentUser) {
        errorMsg.innerText = "Online mode is unavailable (Firebase not configured).";
        errorMsg.classList.remove('hidden');
        return;
    }
    const name = document.getElementById('online-player-name').value.trim();
    if (!name) {
        errorMsg.innerText = "Please enter your name first!";
        errorMsg.classList.remove('hidden');
        return;
    }
    errorMsg.classList.add('hidden');

    window.isOnlineMode = true;
    window.isHost = true;
    window.currentLobbyCode = generateRoomCode();

    const initialData = {
        status: 'lobby',
        hostUid: currentUser.uid,
        settings: { imposterCount: 1 },
        players: [{ uid: currentUser.uid, name: name, role: 'civilian', word: '', isEliminated: false, votes: 0, lastSeen: Date.now() }],
        civilianWord: "", imposterWord: "", currentRound: 1, startingPlayerUid: null, aiQuestion: null, messages: []

    };

    await setDoc(getLobbyRef(window.currentLobbyCode), initialData);
    setupLobbyListener();
    setupSignalingListener();
    startHeartbeat();
    window.showScreen('online-lobby-screen');
};

window.joinOnlineGame = async () => {
    const errorMsg = document.getElementById('online-error-msg');
    if (!currentUser) {
        errorMsg.innerText = "Online mode is unavailable (Firebase not configured).";
        errorMsg.classList.remove('hidden');
        return;
    }
    const name = document.getElementById('online-player-name').value.trim();
    const code = document.getElementById('online-lobby-code').value.trim().toUpperCase();

    if (!name) {
        errorMsg.innerText = "Please enter your name first!";
        errorMsg.classList.remove('hidden');
        return;
    }
    if (code.length !== 4) { errorMsg.innerText = "Invalid 4-letter code"; errorMsg.classList.remove('hidden'); return; }

    const lobbyRef = getLobbyRef(code);
    const docSnap = await getDoc(lobbyRef);

    if (!docSnap.exists()) { errorMsg.innerText = "Lobby not found"; errorMsg.classList.remove('hidden'); return; }
    if (docSnap.data().status !== 'lobby') { errorMsg.innerText = "Game already in progress"; errorMsg.classList.remove('hidden'); return; }

    window.isOnlineMode = true;
    window.isHost = false;
    window.currentLobbyCode = code;

    // Add self to players array
    const data = docSnap.data();
    const newPlayer = { uid: currentUser.uid, name: name, role: 'civilian', word: '', isEliminated: false, votes: 0, lastSeen: Date.now() };


    // Check if reconnecting
    const existingIndex = data.players.findIndex(p => p.uid === currentUser.uid);
    if (existingIndex !== -1) {
        data.players[existingIndex].name = name;
        data.players[existingIndex].lastSeen = Date.now();
    } else {
        data.players.push(newPlayer);
    }

    await updateDoc(lobbyRef, { players: data.players });
    setupLobbyListener();
    setupSignalingListener();
    startHeartbeat();
    window.showScreen('online-lobby-screen');
};

function setupLobbyListener() {
    if (unsubscribeLobby) unsubscribeLobby();
    
    // Use a persistent global to track the UI state across snapshot fires
    window._lastUiHash = null;

    unsubscribeLobby = onSnapshot(getLobbyRef(window.currentLobbyCode), (docSnap) => {
        if (!docSnap.exists()) { window.resetGame(); return; }
        const data = docSnap.data();
        const prevStatus = window.gameState.status;
        
        // Always sync host status and latest game state for background logic
        window.isHost = data.hostUid === currentUser.uid;
        window.gameState = data;

        // --- HOST MIGRATION CHECK ---
        if (window.isOnlineMode && !window.isHost) {
            checkHostStaleness(data);
        }

        // --- ROBUST SMART RERENDER GUARD ---
        // We only rerender UI if fields that ACTUALLY appear on screen changed.
        const uiCriticalData = {
            status: data.status,
            hostUid: data.hostUid,
            currentRound: data.currentRound,
            startingPlayerUid: data.startingPlayerUid,
            winner: data.winner,
            msgCount: (data.messages || []).length,
            players: data.players.map(p => ({
                name: p.name,
                uid: p.uid,
                isEliminated: p.isEliminated,
                votes: p.votes,
                votedFor: p.votedFor,
                role: p.role
            }))
        };
        
        const currentHash = JSON.stringify(uiCriticalData);
        if (window._lastUiHash === currentHash) return;
        window._lastUiHash = currentHash;

        console.log("[LOBBY] Essential state change detected (Votes/Players/Status). Rerendering...");

        // Route UI based on online state


        if (data.status === 'lobby') updateOnlineLobbyUI(data);
        else if (data.status === 'theme_selection' && !window.isHost && prevStatus === 'lobby') {
            document.getElementById('guest-status-text').innerText = "Host is generating words...";
        }
        else if (data.status === 'playing' && prevStatus !== 'playing') {
            window.startOnlineReveal();
        }
        else if (data.status === 'active') {
            if (prevStatus !== 'active') window.showActiveGame();
            else window.renderPlayerList(); // live vote syncing

            // Always sync the starting player name (covers guests who receive it after showActiveGame ran)
            if (data.startingPlayerUid) {
                const starter = (data.players || []).find(p => p.uid === data.startingPlayerUid);
                if (starter) document.getElementById('starting-player-name').innerText = starter.name;
            }

            if (data.aiQuestion && data.aiQuestion !== window._lastAiQuestion) {
                // AI Detective removed — ignore aiQuestion field
                window._lastAiQuestion = data.aiQuestion;
            }
            window.renderChat();
        }
        else if (data.status === 'elimination_result' && prevStatus !== 'elimination_result') {
            showOnlineEliminationResult(data);
        }
        else if (data.status === 'game_over' && prevStatus !== 'game_over') {
            window.showGameOver(data.winner);
        }
    }, (error) => console.error("Lobby listener error:", error));
}

function updateOnlineLobbyUI(data) {
    document.getElementById('lobby-code-display').innerText = window.currentLobbyCode;
    document.getElementById('lobby-player-count').innerText = `${data.players.length}/12`;

    const list = document.getElementById('online-lobby-players');
    list.innerHTML = '';
    data.players.forEach(p => {
        const hostStar = p.uid === data.hostUid ? '⭐ ' : '';
        list.insertAdjacentHTML('beforeend', `<li class="bg-black/30 p-3 rounded shadow border border-white/5 flex justify-between">${hostStar}${p.name} 
                    ${p.uid === currentUser.uid ? '<span class="text-blue-300 text-sm">(You)</span>' : ''}</li>`);
    });

    if (window.isHost) {
        document.getElementById('host-controls').classList.remove('hidden');
        document.getElementById('guest-waiting-msg').classList.add('hidden');
        document.getElementById('online-imposter-count').value = data.settings.imposterCount;
    } else {
        document.getElementById('host-controls').classList.add('hidden');
        document.getElementById('guest-waiting-msg').classList.remove('hidden');
    }
}

window.updateLobbySettings = async () => {
    if (!window.isHost) return;
    const imposterCount = parseInt(document.getElementById('online-imposter-count').value);
    await updateDoc(getLobbyRef(window.currentLobbyCode), { 'settings.imposterCount': imposterCount });
};

window.hostStartGame = async () => {
    if (window.gameState.players.length < 3) return alert("Need at least 3 players!");

    let players = [...window.gameState.players];
    let impostersAssigned = 0;
    const imposterCount = Math.min(window.gameState.settings.imposterCount, players.length - 2);

    // Assign roles
    players.forEach(p => p.role = 'civilian');
    while (impostersAssigned < imposterCount) {
        const randIndex = Math.floor(Math.random() * players.length);
        if (players[randIndex].role !== 'imposter') {
            players[randIndex].role = 'imposter';
            impostersAssigned++;
        }
    }

    await updateDoc(getLobbyRef(window.currentLobbyCode), { status: 'theme_selection', players: players });
    window.showScreen('theme-screen');
};

// --- PRESENCE & HEARTBEAT LOGIC ---
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(async () => {
        if (!window.currentLobbyCode || !window.isOnlineMode) return;

        const lobbyRef = getLobbyRef(window.currentLobbyCode);
        try {
            await runTransaction(db, async (transaction) => {
                const lobbyDoc = await transaction.get(lobbyRef);
                if (!lobbyDoc.exists()) return;
                
                const data = lobbyDoc.data();
                const now = Date.now();
                const STALE_TIMEOUT = 20000;
                let players = [...data.players];
                
                // 1. If I am host, remove other players who have timed out
                if (data.hostUid === currentUser.uid) {
                    const originalCount = players.length;
                    // If a player has NO lastSeen, give them a chance (use now instead of 0)
                    players = players.filter(p => p.uid === currentUser.uid || (now - (p.lastSeen || now) < STALE_TIMEOUT));
                    if (players.length !== originalCount) {
                        console.log(`[HOST] Removed ${originalCount - players.length} inactive player(s).`);
                    }
                }


                // 2. Update my own heartbeat
                const me = players.find(p => p.uid === currentUser.uid);
                if (me) {
                    me.lastSeen = now;
                    transaction.update(lobbyRef, { players: players });
                }
            });
        } catch (e) {
            console.error("Heartbeat error:", e);
        }
    }, 5000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

async function checkHostStaleness(data) {
    const host = data.players.find(p => p.uid === data.hostUid);
    const now = Date.now();
    const STALE_TIMEOUT = 20000; // 20 seconds
    
    // If host is missing or stale
    if (!host || (now - (host.lastSeen || 0) > STALE_TIMEOUT)) {
        console.warn("[HOST MIGRATION] Host is stale or missing. Electing new host...");
        await electNewHost();
    }
}

async function electNewHost() {
    const lobbyRef = getLobbyRef(window.currentLobbyCode);
    try {
        await runTransaction(db, async (transaction) => {
            const lobbyDoc = await transaction.get(lobbyRef);
            if (!lobbyDoc.exists()) return;
            
            const data = lobbyDoc.data();
            const now = Date.now();
            const STALE_TIMEOUT = 20000;

            // Find candidates: Active players (not stale)
            const activePlayers = data.players.filter(p => (now - (p.lastSeen || 0) < STALE_TIMEOUT));
            
            if (activePlayers.length === 0) return; // Everyone is gone?

            // Pick the first active player in the original list
            const newHost = activePlayers[0];
            
            if (data.hostUid !== newHost.uid) {
                console.log("[HOST MIGRATION] New host elected:", newHost.name);
                transaction.update(lobbyRef, { hostUid: newHost.uid });
                
                // Locally update self if we are the new host
                if (newHost.uid === currentUser.uid) {
                    window.isHost = true;
                }
            }
        });
    } catch (e) {
        console.error("Election error:", e);
    }
}


// --- LOCAL SETUP LOGIC ---
window.selectCustomOption = (type, val, text, event) => {
    document.getElementById(`${type}-count`).value = val;
    document.getElementById(`${type}-count-display`).innerText = text;
    document.getElementById(`${type}-dropdown`).classList.add('hidden');

    if (event) {
        const siblings = document.getElementById(`${type}-dropdown`).children;
        for (let child of siblings) child.classList.remove('bg-white/10');
        event.currentTarget.classList.add('bg-white/10');
    }

    if (type === 'player') {
        window.generatePlayerInputs();
    }
};

window.generatePlayerInputs = () => {
    const count = parseInt(document.getElementById('player-count').value);
    const container = document.getElementById('players-container');
    const savedNames = Array.from(container.querySelectorAll('input')).map(input => input.value);

    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const defaultName = savedNames[i] || `Player ${i + 1}`;
        container.insertAdjacentHTML('beforeend', `
                    <div class="relative flex items-center group w-full">
                        <div class="absolute left-4 w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-300 flex items-center justify-center font-display font-bold text-sm border border-cyan-400/30 group-focus-within:bg-cyan-500 group-focus-within:text-black group-focus-within:border-cyan-200 transition-colors shadow-[0_0_10px_rgba(0,195,255,0)] group-focus-within:shadow-[0_0_15px_rgba(0,195,255,0.4)] z-10 pointer-events-none">
                            ${i + 1}
                        </div>
                        <input type="text" value="${defaultName}" placeholder="Enter Name" class="player-name-input w-full glass-input text-white pl-16 pr-4 py-4 text-xl md:text-2xl font-display font-bold rounded-xl transition-all outline-none focus:ring-2 focus:ring-cyan-400 placeholder-white/30 truncate shadow-inner">
                    </div>
                `);
    }

    const imposterInput = document.getElementById('imposter-count');
    let maxImposters = count >= 10 ? 4 : count >= 7 ? 3 : count >= 5 ? 2 : 1;

    if (parseInt(imposterInput.value) > maxImposters) {
        imposterInput.value = maxImposters;
        document.getElementById('imposter-count-display').innerText = maxImposters + (maxImposters === 1 ? ' Imposter' : ' Imposters');
        const children = document.getElementById('imposter-dropdown').children;
        for (let child of children) child.classList.remove('bg-white/10');
        document.getElementById(`imposter-opt-${maxImposters}`)?.classList.add('bg-white/10');
    }

    document.getElementById('imposter-opt-1').style.display = 'block';
    document.getElementById('imposter-opt-2').style.display = 2 > maxImposters ? 'none' : 'block';
    document.getElementById('imposter-opt-3').style.display = 3 > maxImposters ? 'none' : 'block';
    if (document.getElementById('imposter-opt-4')) document.getElementById('imposter-opt-4').style.display = 4 > maxImposters ? 'none' : 'block';
};

window.savePlayersAndProceed = () => {
    window.isOnlineMode = false;
    const inputs = document.querySelectorAll('.player-name-input');
    const imposterCount = parseInt(document.getElementById('imposter-count').value);

    window.gameState.players = Array.from(inputs).map(input => ({
        name: input.value.trim() || input.placeholder,
        role: 'civilian', word: '', isEliminated: false, votes: 0
    }));

    let impostersAssigned = 0;
    while (impostersAssigned < imposterCount) {
        const randIndex = Math.floor(Math.random() * window.gameState.players.length);
        if (window.gameState.players[randIndex].role !== 'imposter') {
            window.gameState.players[randIndex].role = 'imposter';
            impostersAssigned++;
        }
    }
    window.showScreen('theme-screen');
};

// --- AI LOGIC ---
const localWordPairs = {
    "food": [
        { c: "Pizza", i: "Flatbread" }, { c: "Coffee", i: "Tea" }, { c: "Burger", i: "Sandwich" },
        { c: "Sushi", i: "Sashimi" }, { c: "Cake", i: "Muffin" }, { c: "Apple", i: "Pear" },
        { c: "Pasta", i: "Noodles" }, { c: "Steak", i: "Pork Chop" }, { c: "Donut", i: "Bagel" },
        { c: "Lemonade", i: "Orange Juice" }, { c: "Chocolate", i: "Caramel" }, { c: "Waffle", i: "Pancake" }
    ],
    "nature": [
        { c: "Ocean", i: "Lake" }, { c: "Mountain", i: "Hill" }, { c: "Forest", i: "Jungle" },
        { c: "Desert", i: "Savanna" }, { c: "River", i: "Stream" }, { c: "Cave", i: "Tunnel" },
        { c: "Island", i: "Peninsula" }, { c: "Volcano", i: "Mountain" }, { c: "Waterfall", i: "Rapids" }
    ],
    "vehicles": [
        { c: "Car", i: "Truck" }, { c: "Airplane", i: "Helicopter" }, { c: "Train", i: "Subway" },
        { c: "Motorcycle", i: "Scooter" }, { c: "Bicycle", i: "Tricycle" }, { c: "Boat", i: "Ferry" },
        { c: "Rocket", i: "Satellite" }, { c: "Bus", i: "Tram" }
    ],
    "jobs": [
        { c: "Doctor", i: "Nurse" }, { c: "Astronaut", i: "Cosmonaut" }, { c: "Chef", i: "Cook" },
        { c: "Teacher", i: "Tutor" }, { c: "Lawyer", i: "Judge" }, { c: "Pilot", i: "Co-Pilot" },
        { c: "Firefighter", i: "Paramedic" }, { c: "Architect", i: "Engineer" }
    ],
    "animals": [
        { c: "Lion", i: "Tiger" }, { c: "Dolphin", i: "Porpoise" }, { c: "Eagle", i: "Hawk" },
        { c: "Crocodile", i: "Alligator" }, { c: "Rabbit", i: "Hare" }, { c: "Frog", i: "Toad" },
        { c: "Wolf", i: "Coyote" }, { c: "Owl", i: "Hawk" }, { c: "Shark", i: "Barracuda" }
    ],
    "technology": [
        { c: "Smartphone", i: "Tablet" }, { c: "Laptop", i: "Notebook" }, { c: "Robot", i: "Drone" },
        { c: "Internet", i: "Wi-Fi" }, { c: "Camera", i: "Webcam" }, { c: "Keyboard", i: "Keypad" }
    ],
    "sports": [
        { c: "Football", i: "Rugby" }, { c: "Basketball", i: "Netball" }, { c: "Tennis", i: "Badminton" },
        { c: "Chess", i: "Checkers" }, { c: "Baseball", i: "Softball" }, { c: "Skiing", i: "Snowboarding" }
    ],
    "buildings": [
        { c: "Hospital", i: "Clinic" }, { c: "Castle", i: "Fortress" }, { c: "Library", i: "Bookstore" },
        { c: "Stadium", i: "Arena" }, { c: "Apartment", i: "Condo" }, { c: "Lighthouse", i: "Watchtower" }
    ],
    "entertainment": [
        { c: "Guitar", i: "Ukulele" }, { c: "Violin", i: "Viola" }, { c: "Cinema", i: "Theatre" },
        { c: "Concert", i: "Recital" }, { c: "DJ", i: "Producer" }
    ],
    "misc": [
        { c: "Diamond", i: "Crystal" }, { c: "Sword", i: "Dagger" }, { c: "Crown", i: "Tiara" },
        { c: "Map", i: "Compass" }, { c: "Clock", i: "Watch" }, { c: "Candle", i: "Torch" }
    ]
};

// Flattened list for random selection (shuffle-bag)
const flatLocalPairs = Object.values(localWordPairs).flat();

// Shuffle-bag: track used pair indices so nothing repeats until all are exhausted
let usedPairIndices = [];
function getUniquePair(category = null) {
    let source = flatLocalPairs;
    if (category && localWordPairs[category.toLowerCase()]) {
        source = localWordPairs[category.toLowerCase()];
    }

    // If we're picking from a specific small category, just pick random to avoid over-complicating state
    if (category) {
        return source[Math.floor(Math.random() * source.length)];
    }

    // Normal global random with no-repeat logic
    if (usedPairIndices.length >= flatLocalPairs.length) {
        usedPairIndices = [];
    }
    let idx;
    do { idx = Math.floor(Math.random() * flatLocalPairs.length); }
    while (usedPairIndices.includes(idx));
    usedPairIndices.push(idx);
    return flatLocalPairs[idx];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, payload, retries = 3) {
    const delays = [1000, 2000, 4000];
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            if (i === retries - 1) throw error;
            await sleep(delays[i]);
        }
    }
}

async function generateGameWords(theme) {
    const safeTheme = theme.trim().toLowerCase();

    // 1. Try AI if key is present
    if (apiKey && safeTheme) {
        const payload = {
            contents: [{ parts: [{ text: `Theme: ${safeTheme}` }] }],
            systemInstruction: { parts: [{ text: "Word Imposter game. Generate 2 related but distinct words based on theme. 'civilianWord' is the common/obvious one. 'imposterWord' is similar but subtly different. Be creative and vary your responses. Max 2 words each." }] },
            generationConfig: { temperature: 0.9, maxOutputTokens: 40, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { civilianWord: { type: "STRING" }, imposterWord: { type: "STRING" } }, required: ["civilianWord", "imposterWord"] } }
        };
        const fetchPromise = fetchWithRetry(MODEL_URL, payload, 2);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 3500));
        try {
            const data = await Promise.race([fetchPromise, timeoutPromise]);
            const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textResponse) return JSON.parse(textResponse);
        } catch (err) {
            console.warn("AI failed, falling back to local matching.", err);
        }
    }

    // 2. Local Keyword Matching (Fallthrough or if no key)
    if (safeTheme) {
        // Try exact category match first
        const categoryMatch = Object.keys(localWordPairs).find(cat => safeTheme.includes(cat) || cat.includes(safeTheme));
        if (categoryMatch) {
            console.log(`Matched theme "${safeTheme}" to local category "${categoryMatch}"`);
            const rand = getUniquePair(categoryMatch);
            return { civilianWord: rand.c, imposterWord: rand.i };
        }

        // Try word-level match inside pairs
        const wordMatch = flatLocalPairs.find(p => p.c.toLowerCase().includes(safeTheme) || p.i.toLowerCase().includes(safeTheme));
        if (wordMatch) {
            console.log(`Matched theme "${safeTheme}" to local word pair:`, wordMatch);
            return { civilianWord: wordMatch.c, imposterWord: wordMatch.i };
        }
    }

    // 3. Final Fallback: Random
    const rand = getUniquePair();
    return { civilianWord: rand.c, imposterWord: rand.i };
}


window.generateWordsWithAI = async () => {
    const btn = document.getElementById('generate-btn');
    const text = document.getElementById('generate-text');
    const loadText = document.getElementById('generate-loading-text');
    const loader = document.getElementById('generate-loader');

    btn.disabled = true; text.classList.add('hidden'); loadText.classList.remove('hidden'); loader.classList.remove('hidden');

    const funnyMessages = ["Thinking...", "Finding words...", "Hiding imposter..."];
    let msgIndex = 0; loadText.innerText = funnyMessages[0];
    const msgInterval = setInterval(() => { msgIndex = (msgIndex + 1) % funnyMessages.length; loadText.innerText = funnyMessages[msgIndex]; }, 800);

    try {
        const words = await generateGameWords(document.getElementById('custom-theme-input').value);

        if (window.isOnlineMode) {
            let players = [...window.gameState.players];
            players.forEach(p => {
                p.word = p.role === 'imposter' ? words.imposterWord : words.civilianWord;
                p.hasRevealedWord = false; // Initialize the confirmation flag
            });
            await updateDoc(getLobbyRef(window.currentLobbyCode), {
                civilianWord: words.civilianWord, imposterWord: words.imposterWord, players: players, status: 'playing'
            });
        } else {
            window.gameState.civilianWord = words.civilianWord;
            window.gameState.imposterWord = words.imposterWord;
            window.gameState.players.forEach(p => p.word = p.role === 'imposter' ? words.imposterWord : words.civilianWord);
            startLocalPassAndPlay();
        }
    } catch (err) {
        // Silently fall back to a random word pair instead of showing an error
        console.warn('generateWordsWithAI outer catch:', err);
        const fallback = getUniquePair();
        const words = { civilianWord: fallback.c, imposterWord: fallback.i };
        if (window.isOnlineMode) {
            let players = [...window.gameState.players];
            players.forEach(p => {
                p.word = p.role === 'imposter' ? words.imposterWord : words.civilianWord;
                p.hasRevealedWord = false;
            });
            await updateDoc(getLobbyRef(window.currentLobbyCode), {
                civilianWord: words.civilianWord, imposterWord: words.imposterWord, players: players, status: 'playing'
            });
        } else {
            window.gameState.civilianWord = words.civilianWord;
            window.gameState.imposterWord = words.imposterWord;
            window.gameState.players.forEach(p => p.word = p.role === 'imposter' ? words.imposterWord : words.civilianWord);
            startLocalPassAndPlay();
        }
    } finally {
        clearInterval(msgInterval);
        btn.disabled = false; text.classList.remove('hidden'); loadText.classList.add('hidden'); loader.classList.add('hidden');
    }
};

// --- GAME LOOP LOGIC ---
function startLocalPassAndPlay() {
    window.gameState.currentPlayerIndex = 0;
    window.showScreen('pass-screen');
    updateLocalPassScreenUI();
}

window.startOnlineReveal = () => {
    const me = window.gameState.players.find(p => p.uid === currentUser.uid);
    document.getElementById('pass-turn-text').innerText = "Your Turn";
    document.getElementById('cover-subtext').innerText = "It's time to reveal";
    document.getElementById('pass-player-name').innerText = "Your Word";
    document.getElementById('reveal-btn-text').innerText = "Got it! Enter Game";

    setupCard(me);
    window.showScreen('pass-screen');
};

function updateLocalPassScreenUI() {
    const player = window.gameState.players[window.gameState.currentPlayerIndex];
    document.getElementById('pass-turn-text').innerText = `Turn ${window.gameState.currentPlayerIndex + 1} / ${window.gameState.players.length}`;
    document.getElementById('cover-subtext').innerText = "Pass the device to";
    document.getElementById('pass-player-name').innerText = player.name;
    document.getElementById('reveal-btn-text').innerText = "Got it! Hide & Pass";
    setupCard(player);
}

function setupCard(player) {
    document.getElementById('revealed-word').innerText = player.word.toUpperCase();
    const subtitle = document.getElementById('role-subtitle');
    if (player.role === 'imposter') {
        subtitle.innerText = "You are the Imposter. Blend in!"; subtitle.className = "mt-4 text-lg font-bold text-red-400";
    } else {
        subtitle.innerText = "You are a Civilian. Find the liar!"; subtitle.className = "mt-4 text-lg font-bold text-blue-300";
    }
    const coverCard = document.getElementById('top-cover-card');
    coverCard.style.transition = 'none'; coverCard.style.transform = 'translateY(0) rotate(0)'; coverCard.style.opacity = 1; coverCard.style.pointerEvents = 'auto';

    // Reset button state
    const btn = document.getElementById('reveal-btn-text').parentElement;
    btn.disabled = false;
    btn.classList.remove('opacity-50', 'cursor-not-allowed');
}

window.nextPlayerTurn = async () => {
    if (window.isOnlineMode) {
        // Change UI to say "Waiting for others..."
        const btn = document.getElementById('reveal-btn-text').parentElement;
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
        document.getElementById('reveal-btn-text').innerText = "Waiting for others...";

        const myIndex = window.gameState.players.findIndex(p => p.uid === currentUser.uid);
        if (myIndex !== -1) {
            window.gameState.players[myIndex].hasRevealedWord = true;
            const allConfirmed = window.gameState.players.every(p => p.hasRevealedWord);

            if (allConfirmed) {
                await updateDoc(getLobbyRef(window.currentLobbyCode), { status: 'active', players: window.gameState.players });
            } else {
                await updateDoc(getLobbyRef(window.currentLobbyCode), { players: window.gameState.players });
            }
        }
    } else {
        window.gameState.currentPlayerIndex++;
        if (window.gameState.currentPlayerIndex < window.gameState.players.length) updateLocalPassScreenUI();
        else window.showActiveGame();
    }
};

window.showActiveGame = () => {
    window.showScreen('game-active-screen');
    if (!window.isOnlineMode) {
        window.gameState.players.forEach(p => p.votes = 0);
        window.localSelectedPlayerIndex = null;
    }

    document.getElementById('game-round-title').innerText = "Round " + window.gameState.currentRound;

    const activePlayers = window.gameState.players.filter(p => !p.isEliminated);
    const starterUid = window.gameState.startingPlayerUid;

    if (window.isOnlineMode && window.isHost && !starterUid) {
        const randomStarter = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        // Show the name immediately on host's screen, then persist
        document.getElementById('starting-player-name').innerText = randomStarter.name;
        updateDoc(getLobbyRef(window.currentLobbyCode), { startingPlayerUid: randomStarter.uid });
    } else if (!window.isOnlineMode) {
        const randomStarter = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        document.getElementById('starting-player-name').innerText = randomStarter.name;
    } else if (starterUid) {
        const starter = activePlayers.find(p => p.uid === starterUid);
        if (starter) document.getElementById('starting-player-name').innerText = starter.name;
    }

    // UI adjustments for online
    if (window.isOnlineMode) {
        document.getElementById('end-game-btn-text').innerText = "Leave Game";
        document.getElementById('online-chat-container').classList.remove('hidden');
        document.getElementById('online-chat-container').classList.add('flex');
        if (!window.isHost) {
            document.getElementById('eliminate-btn').classList.add('hidden');
            document.getElementById('host-only-msg').classList.remove('hidden');
        } else {
            document.getElementById('eliminate-btn').classList.remove('hidden');
            document.getElementById('host-only-msg').classList.add('hidden');
        }
    } else {
        document.getElementById('end-game-btn-text').innerText = "End Game & Start Over";
        document.getElementById('eliminate-btn').classList.remove('hidden');
        document.getElementById('host-only-msg').classList.add('hidden');
        document.getElementById('online-chat-container').classList.add('hidden');
        document.getElementById('online-chat-container').classList.remove('flex');
    }

    window.renderPlayerList();

};

window.localSelectedPlayerIndex = null;
window.selectLocalTarget = (index) => {
    if (window.gameState.players[index].isEliminated) return;
    window.localSelectedPlayerIndex = index;
    document.getElementById('vote-error-msg').classList.add('hidden');
    window.renderPlayerList();
};

window.renderPlayerList = () => {
    const list = document.getElementById('active-player-list');
    list.innerHTML = '';

    const activePlayersCount = window.gameState.players.filter(p => !p.isEliminated).length;
    const currentTotalVotes = window.gameState.players.reduce((sum, p) => sum + (p.votes || 0), 0);

    const statusEl = document.getElementById('vote-tracker-status');
    if (window.isOnlineMode) {
        statusEl.classList.remove('hidden');
        statusEl.innerText = `Votes Cast: ${currentTotalVotes} / ${activePlayersCount}`;
        statusEl.className = currentTotalVotes >= activePlayersCount ? 'text-center font-display text-red-400 mb-4 font-bold tracking-widest uppercase text-sm transition-colors' : 'text-center font-display text-blue-300 mb-4 font-bold tracking-widest uppercase text-sm transition-colors';
    } else {
        statusEl.className = 'hidden';
    }

    const myPlayer = window.gameState.players.find(p => p.uid === currentUser?.uid);
    const myVoteTarget = myPlayer ? myPlayer.votedFor : null;

    window.gameState.players.forEach((p, index) => {
        if (p.isEliminated) {
            list.insertAdjacentHTML('beforeend', `<div class="bg-red-900/20 p-2 md:p-3 rounded-lg shadow border border-red-900/30 flex justify-between items-center opacity-50"><span class="font-display uppercase tracking-widest text-sm md:text-base line-through text-white/40">${p.name} (Eliminated)</span></div>`);
        } else {
            if (window.isOnlineMode) {
                const isVoted = myVoteTarget === p.uid;
                const canVote = myPlayer && !myPlayer.isEliminated;
                const voteBtnHTML = canVote ? `<button onclick="window.castOnlineVote(${index})" class="px-3 py-1 text-sm md:text-base font-bold rounded transition-colors ${isVoted ? 'bg-blue-600 text-white' : 'bg-white/10 hover:bg-white/20 text-white/70'}">${isVoted ? 'Voted' : 'Vote'}</button>` : '';

                list.insertAdjacentHTML('beforeend', `
                            <div class="glass-panel border-white/10 p-4 sm:p-6 rounded-2xl w-full flex flex-col relative overflow-hidden transition-all hover:bg-black/40 ${isVoted ? 'ring-1 ring-blue-500' : ''}">
                                <span class="font-display uppercase tracking-widest text-sm md:text-base flex-1 truncate pr-2">${p.name} ${p.uid === currentUser?.uid ? '<span class="text-blue-400 text-xs">(You)</span>' : ''}</span>
                                <div class="flex items-center gap-3">
                                    <span class="font-bold text-base md:text-lg text-blue-300">${p.votes || 0} Votes</span>
                                    ${voteBtnHTML}
                                </div>
                            </div>
                        `);
            } else {
                const isSelected = window.localSelectedPlayerIndex === index;
                list.insertAdjacentHTML('beforeend', `
                            <div onclick="window.selectLocalTarget(${index})" class="bg-black/30 p-3 md:p-4 rounded-lg shadow border ${isSelected ? 'border-red-500 bg-red-900/30 ring-1 ring-red-500' : 'border-white/10 hover:bg-black/40'} flex justify-between items-center transition-all cursor-pointer">
                                <span class="font-display font-bold uppercase tracking-widest text-base md:text-lg flex-1 truncate pr-2 ${isSelected ? 'text-white' : 'text-white/80'}">${p.name}</span>
                                ${isSelected ? '<span class="text-red-400 font-bold uppercase text-xs tracking-widest animate-pulse border border-red-500/50 px-2 py-1 rounded bg-red-900/50">Targeted</span>' : '<span class="text-white/30 text-xs uppercase tracking-widest font-bold">Tap to Target</span>'}
                            </div>
                        `);
            }
        }
    });
};

window.castOnlineVote = async (targetIndex) => {
    if (!window.isOnlineMode) return;
    const myPlayer = window.gameState.players.find(p => p.uid === currentUser.uid);
    if (!myPlayer || myPlayer.isEliminated) return;

    const targetPlayer = window.gameState.players[targetIndex];
    myPlayer.votedFor = myPlayer.votedFor === targetPlayer.uid ? null : targetPlayer.uid; // Toggle functionality

    window.gameState.players.forEach(p => p.votes = 0);
    window.gameState.players.forEach(p => {
        if (p.votedFor && !p.isEliminated) {
            const votedPlayer = window.gameState.players.find(x => x.uid === p.votedFor);
            if (votedPlayer) votedPlayer.votes = (votedPlayer.votes || 0) + 1;
        }
    });

    await updateDoc(getLobbyRef(window.currentLobbyCode), { players: window.gameState.players });
};

window.renderChat = () => {
    if (!window.isOnlineMode) return;
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    (window.gameState.messages || []).forEach(msg => {
        const isMe = msg.uid === currentUser.uid;
        const align = isMe ? 'self-end bg-blue-600' : 'self-start bg-black/40 border border-white/5';
        container.insertAdjacentHTML('beforeend', `<div class="${align} max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm"><span class="text-xs text-white/50 block mb-0.5 font-bold">${msg.name} <span class="font-normal opacity-50">${msg.time}</span></span>${msg.text}</div>`);
    });
    container.scrollTop = container.scrollHeight;
};

window.sendChat = async () => {
    if (!window.isOnlineMode) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    const myPlayer = window.gameState.players.find(p => p.uid === currentUser.uid);
    if (!myPlayer) return;

    window.gameState.messages = window.gameState.messages || [];
    window.gameState.messages.push({
        uid: currentUser.uid,
        name: myPlayer.name,
        text: text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    input.value = '';
    await updateDoc(getLobbyRef(window.currentLobbyCode), { messages: window.gameState.messages });
};

window.changeVote = async (index, amount) => {
    document.getElementById('vote-error-msg').classList.add('hidden');
    const p = window.gameState.players[index];
    if (typeof p.votes === 'undefined') p.votes = 0;

    const activePlayersCount = window.gameState.players.filter(x => !x.isEliminated).length;
    const currentTotalVotes = window.gameState.players.reduce((sum, x) => sum + (x.votes || 0), 0);

    if (amount > 0 && currentTotalVotes >= activePlayersCount) return;

    p.votes += amount;
    if (p.votes < 0) p.votes = 0;

    if (window.isOnlineMode) {
        await updateDoc(getLobbyRef(window.currentLobbyCode), { players: window.gameState.players });
    } else {
        window.renderPlayerList();
    }
};

window.eliminateHighestVoteTaker = () => {
    if (window.isOnlineMode && !window.isHost) return;
    const errorMsg = document.getElementById('vote-error-msg');
    errorMsg.classList.add('hidden');

    if (window.isOnlineMode) {
        const activePlayers = window.gameState.players.map((p, index) => ({ ...p, originalIndex: index })).filter(p => !p.isEliminated);
        const maxVotes = Math.max(...activePlayers.map(p => p.votes || 0));

        if (maxVotes === 0) { errorMsg.innerText = "No votes cast!"; errorMsg.classList.remove('hidden'); return; }
        const topVoted = activePlayers.filter(p => (p.votes || 0) === maxVotes);
        if (topVoted.length > 1) { errorMsg.innerText = "Tie! Break it first."; errorMsg.classList.remove('hidden'); return; }

        window.promptEliminate(topVoted[0].originalIndex);
    } else {
        if (window.localSelectedPlayerIndex === null) {
            errorMsg.innerText = "Select a player first! Tap someone's name to target them.";
            errorMsg.classList.remove('hidden');
            return;
        }
        window.promptEliminate(window.localSelectedPlayerIndex);
    }
};

let playerToEliminateIndex = -1;
window.promptEliminate = (index) => {
    playerToEliminateIndex = index;
    document.getElementById('eliminate-target-name').innerText = window.gameState.players[index].name;
    document.getElementById('elimination-modal').classList.remove('hidden');
};

window.closeEliminationModal = () => {
    document.getElementById('elimination-modal').classList.add('hidden');
    playerToEliminateIndex = -1;
};

window.confirmEliminate = async () => {
    if (playerToEliminateIndex === -1) return;
    const targetIndex = playerToEliminateIndex;
    window.gameState.players[targetIndex].isEliminated = true;
    window.closeEliminationModal();
    window.gameState.players.forEach(p => { p.votes = 0; p.votedFor = null; });

    if (window.isOnlineMode) {
        // Determine if game over or next round
        const winner = checkWinner();
        if (winner) {
            await updateDoc(getLobbyRef(window.currentLobbyCode), { status: 'game_over', winner: winner, players: window.gameState.players });
        } else {
            await updateDoc(getLobbyRef(window.currentLobbyCode), { status: 'elimination_result', eliminatedIndex: targetIndex, players: window.gameState.players });
        }
    } else {
        showLocalEliminationResult(targetIndex);
    }
};

function checkWinner() {
    const activeCivilians = window.gameState.players.filter(p => !p.isEliminated && p.role === 'civilian').length;
    const activeImposters = window.gameState.players.filter(p => !p.isEliminated && p.role === 'imposter').length;
    if (activeImposters === 0) return 'civilians';
    if (activeImposters >= activeCivilians) return 'imposters';
    return null;
}

function showLocalEliminationResult(index) {
    const player = window.gameState.players[index];
    document.getElementById('result-target-name').innerText = player.name;
    const roleEl = document.getElementById('result-target-role');
    roleEl.innerText = player.role === 'imposter' ? 'Imposter' : 'Civilian';
    roleEl.className = player.role === 'imposter' ? 'text-4xl font-display font-bold uppercase tracking-wider text-red-600' : 'text-4xl font-display font-bold uppercase tracking-wider text-blue-600';

    document.getElementById('continue-elim-btn').classList.remove('hidden');
    document.getElementById('continue-elim-wait').classList.add('hidden');
    document.getElementById('elimination-result-modal').classList.remove('hidden');
}

function showOnlineEliminationResult(data) {
    const player = data.players[data.eliminatedIndex];
    document.getElementById('result-target-name').innerText = player.name;
    const roleEl = document.getElementById('result-target-role');
    roleEl.innerText = player.role === 'imposter' ? 'Imposter' : 'Civilian';
    roleEl.className = player.role === 'imposter' ? 'text-4xl font-display font-bold uppercase tracking-wider text-red-600' : 'text-4xl font-display font-bold uppercase tracking-wider text-blue-600';

    if (window.isHost) {
        document.getElementById('continue-elim-btn').classList.remove('hidden');
        document.getElementById('continue-elim-wait').classList.add('hidden');
    } else {
        document.getElementById('continue-elim-btn').classList.add('hidden');
        document.getElementById('continue-elim-wait').classList.remove('hidden');
    }
    document.getElementById('elimination-result-modal').classList.remove('hidden');
}

window.continueAfterElimination = async () => {
    document.getElementById('elimination-result-modal').classList.add('hidden');
    const winner = checkWinner();
    if (winner) {
        if (window.isOnlineMode) await updateDoc(getLobbyRef(window.currentLobbyCode), { status: 'game_over', winner: winner });
        else window.showGameOver(winner);
    } else {
        window.gameState.currentRound++;
        if (window.isOnlineMode) {
            await updateDoc(getLobbyRef(window.currentLobbyCode), { status: 'active', currentRound: window.gameState.currentRound, startingPlayerUid: null });
        } else {
            document.getElementById('game-round-title').innerText = "Round " + window.gameState.currentRound;
            window.showActiveGame();
        }
    }
};

window.showGameOver = (winner) => {
    window.showScreen('game-over-screen');
    const title = document.getElementById('winner-title');
    const subtitle = document.getElementById('winner-subtitle');

    if (winner === 'civilians') {
        title.innerText = 'CIVILIANS WIN!'; title.className = 'text-6xl md:text-7xl font-display font-black mb-2 uppercase tracking-wider drop-shadow-lg text-blue-400';
        subtitle.innerText = 'All Imposters were successfully caught!';
    } else {
        title.innerText = 'IMPOSTERS WIN!'; title.className = 'text-6xl md:text-7xl font-display font-black mb-2 uppercase tracking-wider drop-shadow-lg text-red-500';
        subtitle.innerText = 'The Imposters outsmarted the group.';
    }

    document.getElementById('game-over-civilian-word').innerText = window.gameState.civilianWord.toUpperCase();
    document.getElementById('game-over-imposter-word').innerText = window.gameState.imposterWord.toUpperCase();

    const imposterList = document.getElementById('game-over-imposter-list');
    imposterList.innerHTML = '';
    window.gameState.players.filter(p => p.role === 'imposter').forEach(p => {
        imposterList.insertAdjacentHTML('beforeend', `<li class="bg-red-900/30 px-6 py-2 rounded-lg shadow border border-red-500/50">${p.name}</li>`);
    });
};

window.triggerEndGame = () => {
    if (confirm("Are you sure you want to leave the current game?")) window.resetGame();
}



// --- PHYSICAL SLIDE CARD LOGIC ---
document.addEventListener('DOMContentLoaded', () => {
    let startY = 0, currentY = 0, isDraggingCover = false;
    const coverCard = document.getElementById('top-cover-card');

    const handleDragStart = (e) => { isDraggingCover = true; startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY; coverCard.style.transition = 'none'; };
    const handleDragMove = (e) => {
        if (!isDraggingCover) return;
        currentY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
        let deltaY = currentY - startY;
        if (deltaY < 0) { e.preventDefault(); coverCard.style.transform = `translateY(${deltaY}px) rotate(${deltaY * 0.02}deg)`; coverCard.style.opacity = 1 + (deltaY / 400); }
        else { coverCard.style.transform = `translateY(${deltaY * 0.2}px)`; }
    };
    const handleDragEnd = (e) => {
        if (!isDraggingCover) return;
        isDraggingCover = false;
        if ((currentY - startY) < -100) {
            coverCard.style.transition = 'transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.4s ease-out';
            coverCard.style.transform = `translateY(-800px) rotate(-15deg)`; coverCard.style.opacity = 0; coverCard.style.pointerEvents = 'none';
        } else {
            coverCard.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.4s';
            coverCard.style.transform = 'translateY(0) rotate(0)'; coverCard.style.opacity = 1;
        }
    };
    coverCard.addEventListener('mousedown', handleDragStart); document.addEventListener('mousemove', handleDragMove, { passive: false }); document.addEventListener('mouseup', handleDragEnd);
    coverCard.addEventListener('touchstart', handleDragStart, { passive: false }); document.addEventListener('touchmove', handleDragMove, { passive: false }); document.addEventListener('touchend', handleDragEnd);
});