// ========================================
// NOTIFICATIONS - Push / browser notifications module
// ========================================

window.VIP = window.VIP || {};

VIP.notifications = (function () {

    // ---- Service Worker (no-op; registration handled in index.html) ----

    async function registerUserServiceWorker() {
        // No-op: registration is done in index.html inline script
    }

    // ---- Browser notification permission ----

    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
            });
        }
    }

    function showBrowserNotification(title, body, icon = '/favicon.ico') {
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const notification = new Notification(title, {
                    body: body,
                    icon: icon,
                    badge: icon,
                    tag: 'new-message',
                    requireInteraction: false,
                    silent: false
                });
                notification.onclick = () => { window.focus(); notification.close(); };
                setTimeout(() => notification.close(), 5000);
            } catch (e) {
            }
        }
    }

    // ---- Audio notification ----

    function initNotificationSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                VIP.state.notificationAudioContext = new AudioContext();
            }
        } catch (e) {
        }
    }

    function playNotificationSound() {
        if (!VIP.state.notificationAudioContext) {
            initNotificationSound();
        }
        try {
            if (VIP.state.notificationAudioContext) {
                const oscillator = VIP.state.notificationAudioContext.createOscillator();
                const gainNode   = VIP.state.notificationAudioContext.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(VIP.state.notificationAudioContext.destination);

                oscillator.frequency.value = 600;
                oscillator.type = 'sine';

                gainNode.gain.setValueAtTime(0.3, VIP.state.notificationAudioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, VIP.state.notificationAudioContext.currentTime + 0.4);

                oscillator.start(VIP.state.notificationAudioContext.currentTime);
                oscillator.stop(VIP.state.notificationAudioContext.currentTime + 0.4);
            }
        } catch (e) {
        }
    }

    // ---- FCM token registration ----
    // This delegates to the unified window.sendFcmTokenAfterLogin defined in
    // index.html (which handles dedup, retry, and rotation). If that hasn't
    // loaded yet, fall back to a simple one-shot attempt.
    async function sendFcmTokenAfterLogin() {
        // window.sendFcmTokenAfterLogin is set by index.html inline script
        // and is the canonical implementation with dedup/retry/rotation.
        if (typeof window.sendFcmTokenAfterLogin === 'function' &&
            window.sendFcmTokenAfterLogin !== sendFcmTokenAfterLogin) {
            return window.sendFcmTokenAfterLogin();
        }

        // Fallback: simple one-shot if inline script hasn't loaded yet
        const fcmToken  = localStorage.getItem('fcmToken');
        const authToken = localStorage.getItem('userToken');


        if (fcmToken && authToken) {
            try {
                const response = await fetch(`${VIP.config.API_URL}/api/notifications/register-token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + authToken
                    },
                    body: JSON.stringify({ fcmToken: fcmToken })
                });

                const data = await response.json();
                if (data.success) {
                } else {
                }
            } catch (error) {
            }
        }
    }

    return {
        registerUserServiceWorker,
        requestNotificationPermission,
        showBrowserNotification,
        initNotificationSound,
        playNotificationSound,
        sendFcmTokenAfterLogin
    };

})();

// Window alias so index.html inline script can still call registerUserServiceWorker()
window.registerUserServiceWorker = VIP.notifications.registerUserServiceWorker;
// sendFcmTokenAfterLogin may be overridden by index.html inline script (intentional)
window.sendFcmTokenAfterLogin    = VIP.notifications.sendFcmTokenAfterLogin;

// #238 (réplica #971 de PICA ROJA vía CARGASGIROX #211): preferencia de avisos del cliente (Configuración → "Qué avisos querés
// recibir"): GET/POST /api/notifications/prefs. Con el Centro de avisos apagado la fila no se muestra (enabled:false).
VIP.notifPrefs = (function () {
    function _hint(v) { const h = document.getElementById('pfAvisosHint'); if (h) h.textContent = v === 'none' ? 'Sólo Soporte y tus cargas y retiros' : v === 'mine' ? 'Lo tuyo (tu reembolso semanal y los regalos para vos); nada masivo' : 'Bonos del día, novedades y todo lo tuyo'; }
    function paint() {
        const row = document.getElementById('pfAvisosRow'), sel = document.getElementById('pfAvisosSel'); if (!row || !sel || !VIP.state || !VIP.state.currentToken) return;
        fetch(VIP.config.API_URL + '/api/notifications/prefs', { headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken } }).then((x) => x.json()).then((j) => {
            if (!j || !j.success || j.enabled === false) { row.style.display = 'none'; return; }
            row.style.display = ''; sel.value = j.level || 'all'; _hint(sel.value);
        }).catch(() => {});
    }
    async function set(v) {
        try {
            const x = await fetch(VIP.config.API_URL + '/api/notifications/prefs', { method: 'POST', headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ level: v }) });
            const j = await x.json(); if (!(j && j.success)) throw new Error((j && j.error) || 'error');
            _hint(j.level); try { VIP.ui.showToast('Listo, guardado ✓'); } catch (_) {}
        } catch (_) { try { VIP.ui.showToast('No se pudo guardar, probá de nuevo', 'error'); } catch (__) {} paint(); }
    }
    return { paint, set };
})();
