// ========================================
// PLATFORM MODE (#190) — GANAMOS sin API
// ========================================
// Lee GET /api/public/config al arrancar (antes del login) y adapta la PWA:
//   - manual=true → no hay saldo (se oculta), el botón CASINO abre GANAMOS en una
//     pestaña (sin SSO), y el registro público desaparece (la cuenta la crea el
//     agente y manda el link). Reembolsos, nivel VIP y rollover ya NO existen en
//     el HTML (#196: se eliminaron, GANAMOS no los tiene).
//   - publicRegister=false → se oculta "Registrarse".
// Si el endpoint falla, la app sigue con el comportamiento de siempre.
(function () {
    VIP.state.platform = { mode: 'girox', manual: false, playUrl: VIP.config.PLATFORM_URL, publicRegister: true, loaded: false };

    function hide(sel) { document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; }); }

    function applyManualUi() {
        // Saldo: GANAMOS no lo informa.
        hide('.dash-balance');
        const casinoBtn = document.getElementById('plataformaBtn');
        if (casinoBtn) casinoBtn.title = 'Abre la página de GANAMOS en una pestaña nueva';
        document.querySelectorAll('.menu-item-label').forEach((el) => {
            if (/Página CASINO/.test(el.textContent)) el.innerHTML = 'Página CASINO <span style="font-weight:600;color:#00ff88;font-size:11px;">(GANAMOS)</span>';
        });
        if (VIP.ui && typeof VIP.ui.stopBalancePolling === 'function') VIP.ui.stopBalancePolling();
    }

    // #195: el % de referidos sale del comando /sys_referral_pct (GET /api/public/config
    // → referralPct; /api/referrals/me → referralPct del usuario, que puede tener un
    // acuerdo puntual). Todo texto que lo muestre lleva <span class="referral-pct">
    // y el ejemplo de $100.000 lleva class="referral-pct-example".
    function applyReferralPct(pct) {
        const n = Number(pct);
        if (!Number.isFinite(n) || n <= 0) return;
        VIP.state.referralPct = n;
        const txt = String(n).replace('.', ',');
        document.querySelectorAll('.referral-pct').forEach((el) => { el.textContent = txt; });
        const ejemplo = '$' + new Intl.NumberFormat('es-AR').format(Math.round(100000 * n / 100));
        document.querySelectorAll('.referral-pct-example').forEach((el) => { el.textContent = ejemplo; });
    }

    function applyRegisterUi(enabled) {
        if (enabled) return;
        const btn = document.getElementById('registerBtn');
        if (btn && btn.parentElement) btn.parentElement.style.display = 'none';
    }

    VIP.platform = {
        isManual: () => !!(VIP.state.platform && VIP.state.platform.manual),
        playUrl: () => (VIP.state.platform && VIP.state.platform.playUrl) || VIP.config.PLATFORM_URL,
        applyReferralPct,
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
                if (j.referralPct != null) applyReferralPct(j.referralPct); // (#207: en GANAMOS ya no viene)
            } catch (_) { /* sin config: comportamiento por defecto */ }
        }
    };

    const start = () => { VIP.platform.load(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
