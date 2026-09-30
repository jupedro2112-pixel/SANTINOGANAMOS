// ========================================
// INSTALL BONUS - Bono one-time por instalar la app
// ========================================
// Muestra un cartel en el chat con un botón para reclamar el 100% en la próxima
// carga. NO acredita plata: deja el bono pendiente para que el agente lo aplique. Solo
// se acredita estando dentro de la app instalada (display-mode: standalone).
// Si el usuario no está en la app instalada, se le explica cómo instalarla;
// si insiste y sigue fallando, se le explica borrar caché y reinstalar.

window.VIP = window.VIP || {};

VIP.installBonus = (function () {

    let _claimed = true; // por defecto no mostramos el cartel hasta confirmar con el server

    function _el(id) { return document.getElementById(id); }

    // Consulta el estado del bono y muestra/oculta el cartel.
    async function init() {
        const banner = _el('installBonusBanner');
        if (!banner) return;
        try {
            const res = await fetch(`${VIP.config.API_URL}/api/install-bonus/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                _claimed = data.claimed === true;
                // #188 regla del bono (tope + excedente) → textos de la app.
                if (data.rule) { VIP.state.installBonusRule = data.rule; _applyRuleTexts(data.rule); }
            }
        } catch (e) { /* si falla, dejamos el cartel oculto */ }
        banner.style.display = _claimed ? 'none' : '';

        // Aviso solo para usuarios que se registraron DIRECTO (sin pauta): el
        // bono es para probar la página y no es retirable hasta ser usuario
        // activo. Si vino por pauta, el flujo es distinto y no mostramos esto.
        // Usamos acquisitionCampaign del usuario (verdad del server), no la
        // atribución de localStorage (que vence a los 60 días).
        const notice = _el('installBonusDirectNotice');
        if (notice) {
            const fromPauta = !!(VIP.state.currentUser && VIP.state.currentUser.acquisitionCampaign);
            notice.style.display = (!_claimed && !fromPauta) ? '' : 'none';
        }

        VIP.ui.adjustLayout();
    }

    // #188 Pinta la regla vigente (pct / tope / excedente) en todos los textos que
    // hablan del bono: cartel del home, aviso, Información del Servicio y el
    // modal de pauta. Así nunca queda un "100%" fijo que después genere quejas.
    function _applyRuleTexts(r) {
        const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
        const pct = Number(r.pct) || 100;
        const cap = Number(r.capArs) || 0;
        const ex = Number(r.excessPct) || 0;
        const corto = pct + '% de bono' + (cap > 0 ? ' hasta ' + money(cap) : '');
        const set = (id, txt) => { const el = _el(id); if (el) el.textContent = txt; };
        // #211 cartel compacto: título + una línea corta con el excedente; la regla larga ya no se muestra.
        set('installBonusTitle', '¡' + corto + ' en tu próxima carga!');
        set('installBonusSub', 'Por instalar la app · por única vez' + (cap > 0 && ex > 0 ? ' · sobre lo que cargues de más, ' + ex + '%' : ''));
        set('installBonusClaimBtn', '🎁 Reclamar');
        set('installBonusRuleText', r.text || '');
        set('infoInstallBonusDesc', 'Instalá la app, reclamá el bono y en tu próxima carga te damos el ' + pct + '%' + (cap > 0 ? ' (hasta ' + money(cap) + ' de carga' + (ex > 0 ? '; sobre el resto, el ' + ex + '%' : '') + ')' : '') + '. Por única vez.');
        set('adInstallBonusTitle', 'Bono ' + pct + '% con la app');
        set('adInstallBonusDesc', 'Instalá la app y tu próxima carga suma un ' + pct + '%' + (cap > 0 ? ' (hasta ' + money(cap) + (ex > 0 ? ' + ' + ex + '% del resto' : '') + ')' : '') + '.');
        const notice = _el('installBonusDirectNotice');
        if (notice) notice.innerHTML = '⚠️ Por única vez. Al cargar, avisale al agente que tenés el bono del ' + pct + '% por instalar la app.';
    }
    function _escHtml(t) { const d = document.createElement('div'); d.textContent = String(t == null ? '' : t); return d.innerHTML; }

    async function claim() {
        const btn = _el('installBonusClaimBtn');

        // El bono solo se reclama desde la app instalada.
        if (!VIP.ui.isAppStandalone()) {
            _showHelp();
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Reclamando...'; }
        try {
            const res = await fetch(`${VIP.config.API_URL}/api/install-bonus/claim`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ standalone: true })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                _claimed = true;
                const banner = _el('installBonusBanner');
                if (banner) banner.style.display = 'none';
                localStorage.removeItem('installBonusFailedAttempts');
                VIP.ui.adjustLayout();
                VIP.ui.showToast('🎁 ¡Tenés un ' + ((VIP.state.installBonusRule && VIP.state.installBonusRule.pct) || 100) + '% de bono en tu próxima carga!', 'success');
                setTimeout(() => VIP.ui.syncBalance(), 1000);
                setTimeout(() => VIP.chat.loadMessages(), 800);
            } else if (data.code === 'NOT_STANDALONE') {
                _showHelp();
            } else if (data.code === 'PHONE_VERIFICATION_REQUIRED') {
                // Requisito anti-multi-cuenta: pedir verificación de teléfono y
                // abrir el modal de verify-phone en su paso 1 (limpio).
                VIP.ui.showToast(data.error || '📱 Verificá tu teléfono por SMS para poder reclamar el bono.', 'info');
                const s1 = _el('verifyPhoneStep1');
                const s2 = _el('verifyPhoneStep2');
                const input = _el('verifyPhoneInput');
                const err = _el('verifyPhoneError');
                if (s1) s1.style.display = '';
                if (s2) s2.style.display = 'none';
                if (input) input.value = '';
                if (err) err.classList.remove('show');
                VIP.ui.showModal('verifyPhoneModal');
            } else if (data.code === 'ALREADY_CLAIMED') {
                _claimed = true;
                const banner = _el('installBonusBanner');
                if (banner) banner.style.display = 'none';
                VIP.ui.adjustLayout();
                VIP.ui.showToast('Ya habías reclamado este bono.', 'info');
            } else {
                VIP.ui.showToast(data.error || 'No se pudo reclamar el bono', 'error');
            }
        } catch (e) {
            VIP.ui.showToast('Error de conexión', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🎁 Reclamar'; }
        }
    }

    // Cuenta los intentos fallidos: el 1ro explica cómo instalar bien;
    // del 2do en adelante, además explica borrar caché y reinstalar.
    function _showHelp() {
        let fails = parseInt(localStorage.getItem('installBonusFailedAttempts') || '0', 10);
        fails += 1;
        localStorage.setItem('installBonusFailedAttempts', String(fails));
        _renderHelpModal(fails >= 2);
    }

    function _renderHelpModal(showReinstall) {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

        const installSteps = isIOS
            ? [
                'Abrí esta página en <strong>Safari</strong> (no en otro navegador).',
                'Tocá el botón <strong>Compartir</strong> ⬆️ en la barra de abajo.',
                'Deslizá y elegí <strong>"Agregar a pantalla de inicio"</strong>, después <strong>"Agregar"</strong>.',
                'Abrí la app desde el ícono nuevo en tu pantalla de inicio.'
              ]
            : [
                'Abrí esta página en <strong>Google Chrome</strong>.',
                'Tocá el menú <strong>⋮</strong> (arriba a la derecha).',
                'Elegí <strong>"Instalar app"</strong> o <strong>"Agregar a pantalla de inicio"</strong>.',
                'Abrí la app desde el ícono nuevo en tu pantalla de inicio.'
              ];

        const reinstallHtml = showReinstall ? `
            <div style="background: rgba(255,68,68,0.12); border: 1px solid rgba(255,68,68,0.5); border-radius: 10px; padding: 12px 14px; margin-top: 14px; text-align: left;">
                <p style="margin: 0 0 6px; color: #ff6b6b; font-weight: 700; font-size: 13px;">¿Seguís sin poder reclamarlo? Reinstalá la app:</p>
                <ol style="margin: 0; padding-left: 18px; color: #ddd; font-size: 12px; line-height: 1.65;">
                    <li>Borrá / desinstalá la app de tu pantalla de inicio.</li>
                    <li>En el navegador, borrá el <strong>caché</strong> y los datos del sitio.</li>
                    <li>Volvé a abrir la página y reinstalá la app con los pasos de arriba.</li>
                    <li>Abrí la app instalada y tocá de nuevo <strong>"🎁 Reclamar mi 100%"</strong>.</li>
                </ol>
            </div>` : '';

        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';
        modal.innerHTML = `
            <div class="ios-install-content">
                <h3>🎁 Reclamá tu 100% de bono</h3>
                <p style="color:#f7931e;margin-bottom:10px;">El bono se reclama <strong>desde la app instalada</strong>. Parece que todavía no la estás usando instalada.</p>
                <p style="color:#fff;font-size:13px;margin-bottom:8px;text-align:left;">Hacé estos pasos:</p>
                <ol style="text-align:left;">${installSteps.map(s => `<li>${s}</li>`).join('')}</ol>
                <p style="color:#00ff88;font-size:13px;margin-top:10px;">Ya dentro de la app instalada, tocá <strong>"🎁 Reclamar mi 100%"</strong> y el bono se acredita al instante.</p>
                ${reinstallHtml}
                <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
            </div>
        `;
        document.body.appendChild(modal);
    }

    return { init, claim };

})();
