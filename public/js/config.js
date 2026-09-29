// ========================================
// CONFIG - VIP Namespace & shared state
// ========================================

window.VIP = window.VIP || {};

VIP.config = {
    API_URL: '',
    // Sitio de juego (1girox). Sólo se usa como respaldo, cuando el login único (SSO)
    // falla y el usuario tiene que entrar a mano desde el modal. El camino normal es
    // VIP.ui.enterCasino(), que recibe del backend un link de acceso ya autenticado.
    // #190 GANAMOS: la URL real la manda el backend (GET /api/public/config → GANAMOS_PLAY_URL).
    PLATFORM_URL: 'https://ganamos.io',
    FRONTEND_MSG_RATE_MAX: 2,
    FRONTEND_MSG_RATE_WINDOW_MS: 1000,
    CBU_CLICK_COOLDOWN_MS: 10000
};

// Shared mutable application state (all modules read/write through here)
VIP.state = {
    currentToken: localStorage.getItem('userToken'),
    currentUser: null,
    socket: null,
    refundStatus: null,
    refundTimers: {},
    lastMessageId: null,
    messageCheckInterval: null,
    balanceCheckInterval: null,
    processedMessageIds: new Set(),
    pendingSentMessages: new Map(),
    lastSentMessageTimestamp: 0,
    passwordChangePending: false,
    sentMessageTimestamps: [],
    lastCbuClickTime: 0,
    notificationAudioContext: null,
    isLoadingMessages: false,
    lastMessagesHash: '',
    fireStatus: null,
    fireCountdownInterval: null,
    referralData: null,
    sessionPassword: ''
};

// ---- Argentina timezone helpers (used across modules) ----

function getArgentinaDate(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

function getArgentinaMidnight() {
    const argentinaNow = getArgentinaDate();
    const midnight = new Date(argentinaNow);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
}

window.getArgentinaDate = getArgentinaDate;
window.getArgentinaMidnight = getArgentinaMidnight;
