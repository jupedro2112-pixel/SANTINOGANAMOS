// ========================================
// PLATFORM MODE (#190) — GANAMOS sin API
// ========================================
// Lee GET /api/public/config al arrancar (antes del login) y adapta la PWA:
//   - manual=true → no hay saldo (se oculta), no hay reembolsos ni nivel VIP (se
//     ocultan), el botón CASINO abre GANAMOS en una pestaña (sin SSO), y el
//     registro público desaparece (la cuenta la crea el agente y manda el link).
//   - publicRegister=false → se oculta "Registrarse".
// Si el endpoint falla, la app sigue con el comportamiento de siempre.
(function () {
    VIP.state.platform = { mode: 'girox', manual: false, playUrl: VIP.config.PLATFORM_URL, publicRegister: true, loaded: false };

    function hide(sel) { document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; }); }

    function applyManualUi() {
        // Saldo: GANAMOS no lo informa.
        hide('.dash-balance');
        // Reembolsos / nivel VIP: sin netwin no existen (apagados por el owner).
        hide('.dash-refunds');
        hide('.dash-user');
        hide('.menu-item.profile-btn');
        // Rollover: sigue existiendo (lo aplica el agente en GANAMOS); no se toca.
        const casinoBtn = document.getElementById('plataformaBtn');
        if (casinoBtn) casinoBtn.title = 'Abre la página de GANAMOS en una pestaña nueva';
        document.querySelectorAll('.menu-item-label').forEach((el) => {
            if (/Página CASINO/.test(el.textContent)) el.innerHTML = 'Página CASINO <span style="font-weight:600;color:#00ff88;font-size:11px;">(GANAMOS)</span>';
        });
        if (VIP.ui && typeof VIP.ui.stopBalancePolling === 'function') VIP.ui.stopBalancePolling();
    }

    function applyRegisterUi(enabled) {
        if (enabled) return;
        const btn = document.getElementById('registerBtn');
        if (btn && btn.parentElement) btn.parentElement.style.display = 'none';
    }

    VIP.platform = {
        isManual: () => !!(VIP.state.platform && VIP.state.platform.manual),
        playUrl: () => (VIP.state.platform && VIP.state.platform.playUrl) || VIP.config.PLATFORM_URL,
        apply: function () {
            if (VIP.state.platform.manual) applyManualUi();
            applyRegisterUi(VIP.state.platform.publicRegister);
        },
        load: async function () {
            try {
                const r = await fetch(`${VIP.config.API_URL}/api/public/config`, { cache: 'no-store' });
                if (!r.ok) return;
                const j = await r.json();
                VIP.state.platform = {
                    mode: j.platformMode || 'girox',
                    manual: !!j.manual,
                    playUrl: j.playUrl || VIP.config.PLATFORM_URL,
                    publicRegister: j.publicRegister !== false,
                    brand: j.brand || 'GANAMOS',
                    loaded: true
                };
                if (j.playUrl) VIP.config.PLATFORM_URL = j.playUrl;
                VIP.platform.apply();
            } catch (_) { /* sin config: comportamiento por defecto */ }
        }
    };

    const start = () => { VIP.platform.load(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
