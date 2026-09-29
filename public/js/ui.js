// ========================================
// UI - User-interface utilities module
// ========================================

window.VIP = window.VIP || {};

VIP.ui = (function () {

    // ---- Modal helpers ----

    function showModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    }

    function hideModal(modalId) {
        if (modalId === 'changePasswordModal' && VIP.state.passwordChangePending) {
            return;
        }
        document.getElementById(modalId).classList.add('hidden');

        // Reset OTP step states when closing modals
        if (modalId === 'resetPassModal') {
            const s1 = document.getElementById('resetStep1');
            const s2 = document.getElementById('resetStep2');
            const s3 = document.getElementById('resetStep3');
            if (s1) s1.style.display = '';
            if (s2) s2.style.display = 'none';
            if (s3) s3.style.display = 'none';
        }
        if (modalId === 'registerModal') {
            const s1 = document.getElementById('registerStep1');
            if (s1) s1.style.display = '';
        }
    }

    // ---- Toast & copy ----

    function showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 3000);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('✅ Copiado');
        } catch (error) {
            showToast('Error al copiar', 'error');
        }
    }

    function copyToClipboard(elementId) {
        const element = document.getElementById(elementId);
        const text = element.textContent;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('📋 Copiado al portapapeles', 'success');
            }).catch(() => { fallbackCopy(text); });
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity  = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        try { document.execCommand('copy'); showToast('✅ Copiado', 'success'); } catch (e) {}
        document.body.removeChild(el);
    }

    // ---- Screen switching ----

    function showLoginScreen() {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('chatScreen').classList.add('hidden');
    }

    function showChatScreen() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('chatScreen').classList.remove('hidden');
        const _username = VIP.state.currentUser?.username || 'Usuario';
        const _curUser = document.getElementById('currentUser');
        if (_curUser) _curUser.textContent = _username;
        const _dashUser = document.getElementById('dashUserName');
        if (_dashUser) _dashUser.textContent = _username;

        adjustLayout();
        syncBalance();
        startBalancePolling();
        sendWelcomeMessages();

        // Cartel del bono por instalar la app (se muestra si no lo reclamó aún).
        if (VIP.installBonus && typeof VIP.installBonus.init === 'function') {
            VIP.installBonus.init();
        }

        // Encuesta de notificaciones: aparece una sola vez para que el
        // usuario elija su grupo (suave / normal / activo / solo reembolsos).
        if (VIP.notifSurvey && typeof VIP.notifSurvey.maybeShow === 'function') {
            VIP.notifSurvey.maybeShow();
        }
        // NOTA: el welcome del publicista NO se muestra acá. Se muestra
        // pre-auth desde app.js al cargar la página si el visitante llegó
        // por una vanity URL / ?p=CODE. Ver public/js/publisherwelcome.js.
    }

    // ---- Layout ----

    function adjustLayout() {
        // El layout ahora es una columna flex (.chat-screen): el header y la
        // barra de escribir están en el flujo normal y el chat ocupa el resto
        // con flex:1. No hace falta compensar con márgenes.
    }

    // ---- Balance ----

    async function syncBalance() {
        if (!VIP.state.currentToken || !VIP.state.currentUser) return;

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/balance/live`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            if (response.ok) {
                const data = await response.json();
                // #190 modo manual (GANAMOS sin API): no hay saldo → ocultar y dejar de pollear.
                if (data.manual) {
                    if (VIP.state.platform) VIP.state.platform.manual = true;
                    document.querySelectorAll('.dash-balance').forEach((el) => { el.style.display = 'none'; });
                    stopBalancePolling();
                    return;
                }
                if (data.balance !== undefined && data.balance !== null) {
                    VIP.state.currentUser.balance = data.balance;
                    updateBalanceDisplay(data.balance);

                    const previousBalance = parseFloat(localStorage.getItem('lastBalance') || '0');
                    const newBalance      = parseFloat(data.balance);
                    if (Math.abs(newBalance - previousBalance) > 0.01) {
                        localStorage.setItem('lastBalance', newBalance);
                        if (newBalance > previousBalance) {
                            // Subió el saldo (carga/premio): invitación grande al
                            // casino en vez del toast chico (owner 2026-08-05).
                            showCasinoInvite(newBalance);
                        } else {
                            showBalanceToast(newBalance);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error sincronizando saldo:', error);
        }
    }

    // Saldo empujado por SOCKET (el server emite `balance_updated` al acreditar
    // una carga, premio o devolución): mismo tratamiento que el polling, pero
    // instantáneo — el cliente ve la invitación al casino apenas el agente carga.
    function handleBalancePush(balance) {
        const newBalance = parseFloat(balance);
        if (!Number.isFinite(newBalance)) return;
        if (VIP.state.currentUser) VIP.state.currentUser.balance = newBalance;
        updateBalanceDisplay(newBalance);
        const previousBalance = parseFloat(localStorage.getItem('lastBalance') || '0');
        if (Math.abs(newBalance - previousBalance) > 0.01) {
            localStorage.setItem('lastBalance', newBalance);
            if (newBalance > previousBalance) {
                showCasinoInvite(newBalance);
            } else {
                showBalanceToast(newBalance);
            }
        }
    }

    // ---- Invitación al casino tras una carga (owner 2026-08-05) ----
    // Cuando el saldo SUBE, un recuadro grande y bien visible invita a entrar al
    // casino YA LOGUEADO (VIP.ui.enterCasino, el SSO de siempre). Se va solo a
    // los 15 segundos (barra de tiempo incluida) o con la ✕. Throttle de 60s:
    // el evento puede llegar por socket Y por el polling de saldo — una sola vez.
    let _lastCasinoInviteAt = 0;
    let _casinoInviteTimer = null;

    function showCasinoInvite(balance) {
        const now = Date.now();
        if (now - _lastCasinoInviteAt < 60000) return;
        if (!VIP.state.currentUser) return;
        if (VIP.ui._casinoOpen) return; // ya está jugando: no tapar el casino
        _lastCasinoInviteAt = now;

        let box = document.getElementById('casinoInviteBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'casinoInviteBox';
            box.style.cssText =
                'position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:19000;' +
                'width:min(92vw,380px);background:linear-gradient(150deg,#1a0033,#2d0052);' +
                'border:2px solid #ffd700;border-radius:18px;padding:18px 16px 14px;text-align:center;' +
                'box-shadow:0 12px 44px rgba(212,175,55,0.6);display:none;';
            document.body.appendChild(box);
        }
        const amt = Number(balance) || 0;
        box.innerHTML =
            '<button type="button" onclick="VIP.ui.hideCasinoInvite()" ' +
                'style="position:absolute;top:6px;right:10px;background:none;border:none;color:#999;font-size:20px;cursor:pointer;line-height:1;">×</button>' +
            '<div style="font-size:30px;line-height:1;margin-bottom:6px;">💰</div>' +
            '<div style="color:#00ff88;font-weight:900;font-size:16px;margin-bottom:2px;">¡Saldo acreditado!</div>' +
            '<div style="color:#fff;font-weight:800;font-size:22px;margin-bottom:10px;">$' + amt.toLocaleString('es-AR') + '</div>' +
            '<button type="button" onclick="VIP.ui.hideCasinoInvite();VIP.ui.enterCasino();" ' +
                'style="width:100%;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;' +
                'padding:14px;border-radius:26px;font-weight:900;font-size:16px;cursor:pointer;' +
                'box-shadow:0 4px 16px rgba(212,175,55,0.5);">🎰 JUGAR AHORA EN GANAMOS</button>' +
            '<div style="color:#aaa;font-size:10.5px;margin-top:7px;">Entrás directo, con tu sesión ya iniciada</div>' +
            // 🪦 Acá iba el cartel informativo del código de $5.000: reemplazado
            // (owner 2026-08-05) por la mini-ENCUESTA de Comunidad de abajo.
            (localStorage.getItem('communitySurveyDone') === '1' ? '' :
            '<div id="casinoInviteSurvey" style="margin-top:9px;padding:9px 10px;background:rgba(41,169,235,0.10);border:1px solid rgba(41,169,235,0.45);border-radius:10px;">' +
                '<div style="color:#9ad8f7;font-size:11.5px;font-weight:800;">📣 ¿Ya estás en nuestra Comunidad de Telegram?</div>' +
                '<div style="color:#8fb9cc;font-size:10px;margin-top:2px;">Bonos, códigos gratis y avisos exclusivos.</div>' +
                '<div style="display:flex;gap:8px;margin-top:8px;">' +
                    '<button type="button" onclick="VIP.ui.casinoInviteJoinCommunity()" ' +
                        'style="flex:1;background:linear-gradient(135deg,#29a9eb,#53bdeb);color:#fff;border:none;padding:9px 6px;border-radius:18px;font-weight:900;font-size:12px;cursor:pointer;">🚀 SÍ, quiero entrar</button>' +
                    '<button type="button" onclick="VIP.ui.casinoInviteAlreadyIn()" ' +
                        'style="flex:1;background:rgba(255,255,255,0.10);color:#cde;border:1px solid rgba(255,255,255,0.25);padding:9px 6px;border-radius:18px;font-weight:800;font-size:12px;cursor:pointer;">✅ Ya estoy en la Comunidad</button>' +
                '</div>' +
            '</div>') +
            '<div style="height:3px;background:rgba(255,255,255,0.12);border-radius:2px;margin-top:9px;overflow:hidden;">' +
                '<div id="casinoInviteBar" style="height:100%;width:100%;background:#ffd700;transition:width 15s linear;"></div></div>';
        box.style.display = 'block';

        // Barra de tiempo: 100% → 0 en los 15s de vida del recuadro.
        requestAnimationFrame(function () {
            const bar = document.getElementById('casinoInviteBar');
            if (bar) requestAnimationFrame(function () { bar.style.width = '0%'; });
        });
        clearTimeout(_casinoInviteTimer);
        _casinoInviteTimer = setTimeout(hideCasinoInvite, 15000);
    }

    function hideCasinoInvite() {
        clearTimeout(_casinoInviteTimer);
        const box = document.getElementById('casinoInviteBox');
        if (box) box.style.display = 'none';
    }

    // ---- Mini-encuesta de Comunidad dentro de la invitación al casino ----
    // "SÍ, quiero entrar" → abre la Comunidad de Telegram (el link que se carga
    // en el panel → sección Comandos → card Comunidad; chat.js lo mantiene
    // aplicado en el pill del header, con fallback al dominio propio).
    // Cualquiera de las dos respuestas queda recordada: la encuesta no se
    // repite en próximas cargas (localStorage), el resto del cartel sigue igual.
    function casinoInviteJoinCommunity() {
        try { localStorage.setItem('communitySurveyDone', '1'); } catch (e) {}
        const pill = document.getElementById('canalTelegramHeaderBtn');
        // Fallback /go/comunidad: el server redirige al link vigente de la config
        // (owner 2026-08-06 — nunca más el 404 de canal-proximamente).
        const url = (pill && pill.href) || '/go/comunidad';
        window.open(url, '_blank', 'noopener');
        const s = document.getElementById('casinoInviteSurvey');
        if (s) s.style.display = 'none';
    }

    function casinoInviteAlreadyIn() {
        try { localStorage.setItem('communitySurveyDone', '1'); } catch (e) {}
        const s = document.getElementById('casinoInviteSurvey');
        if (s) s.style.display = 'none';
        showToast('¡Genial! 🙌 Gracias por estar en la Comunidad', 'success');
    }

    function showBalanceToast(balance) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            background: linear-gradient(135deg, #00ff88 0%, #00cc6a 100%);
            color: #000;
            padding: 15px 25px;
            border-radius: 12px;
            font-weight: bold;
            font-size: 16px;
            z-index: 10000;
            animation: slideIn 0.3s ease;
            box-shadow: 0 5px 20px rgba(0, 255, 136, 0.4);
        `;
        toast.innerHTML = `💰 Saldo actualizado: <span style="font-size: 20px;">$${balance.toLocaleString()}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function updateBalanceDisplay(balance) {
        const balanceElement = document.getElementById('userBalance');
        if (balanceElement) {
            balanceElement.textContent = `$${balance.toLocaleString()}`;
        }
    }

    function startBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
        }
        // 90s (era 30s): el saldo igual se refresca al instante por socket
        // (balance_updated) en cargas/retiros/bonos y al cerrar el casino; el
        // poll solo cubre cambios por juego mientras el cliente mira la PWA sin
        // jugar. Es la mitad-front del fix del lag (cada poll gasta una request
        // del cupo de la key de 1girox del publicista).
        VIP.state.balanceCheckInterval = setInterval(syncBalance, 90000);
    }

    function stopBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
            VIP.state.balanceCheckInterval = null;
        }
    }

    // ---- Welcome message ----

    async function sendWelcomeMessages() {
        const welcomeKey  = 'lastWelcome_' + (VIP.state.currentUser?.userId || '');
        const lastWelcome = parseInt(localStorage.getItem(welcomeKey) || '0');
        const hoursSince  = (Date.now() - lastWelcome) / 3600000;
        if (hoursSince < 24) {
            return;
        }

        // La bienvenida ahora la genera el BACKEND como mensaje de sistema
        // (lado admin), no el cliente. Antes se mandaba con el token del
        // usuario vía sendSystemMessage → quedaba registrada con
        // senderRole='user' y aparecía como si la hubiera escrito el propio
        // usuario. El endpoint /api/messages/welcome la crea con
        // senderRole='admin' y tiene su propio throttle de 24h server-side.
        //
        // CON REINTENTOS (fix 2026-08-05): antes un fallo de red se tragaba en
        // silencio y sin retry → el cliente entraba (típico: por link de acceso
        // en una red lenta/Tor) con el chat VACÍO, y como la bienvenida es la
        // que crea el ChatStatus, el chat tampoco aparecía del lado del admin
        // hasta que el cliente escribiera o recargara la página.
        const delays = [0, 2500, 7000]; // 3 intentos
        for (let i = 0; i < delays.length; i++) {
            if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
            try {
                const response = await fetch(`${VIP.config.API_URL}/api/messages/welcome`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${VIP.state.currentToken}`
                    }
                });
                if (response.ok) {
                    // Refrescar el chat para mostrar los mensajes recién creados.
                    setTimeout(() => { try { VIP.chat.loadMessages(); } catch (e) {} }, 300);
                    localStorage.setItem(welcomeKey, Date.now().toString());
                    return;
                }
                // 4xx (ej. 401 por sesión a medio armar): reintentar igual — el
                // endpoint es idempotente (throttle server-side de 24h).
            } catch (error) {
                // red caída/lenta: probamos de nuevo con el próximo delay
            }
        }
        console.warn('[welcome] no se pudo enviar la bienvenida tras 3 intentos (se reintenta en la próxima carga)');
    }

    // ---- CBU ----

    async function loadAndShowCBU() {
        const now = Date.now();
        if (now - VIP.state.lastCbuClickTime < VIP.config.CBU_CLICK_COOLDOWN_MS) {
            showToast('Espera unos segundos antes de volver a solicitar el CBU.', 'info');
            return;
        }
        VIP.state.lastCbuClickTime = now;

        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/cbu/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metaEventId })
            });

            if (response.ok) {
                const data = await response.json();
                document.getElementById('cbuBankDisplay').textContent    = data.cbu.bank    || '-';
                document.getElementById('cbuTitularDisplay').textContent = data.cbu.titular || '-';
                document.getElementById('cbuNumberDisplay').textContent  = data.cbu.number  || '-';
                document.getElementById('cbuAliasDisplay').textContent   = data.cbu.alias   || '-';

                showModal('cbuModal');
                setTimeout(() => VIP.chat.loadMessages(), 500);
                showToast('💳 Datos CBU enviados al chat', 'success');

                // Meta Pixel — InitiateCheckout (usuario va a depositar).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'InitiateCheckout', { content_name: 'cbu_request' });
            } else {
                showToast('Error solicitando CBU', 'error');
            }
        } catch (error) {
            console.error('Error solicitando CBU:', error);
            showToast('Error de conexión', 'error');
        }
    }

    // ---- Referrals ----

    async function openReferralModal() {
        showModal('referralModal');
        await loadReferralData();
    }

    async function loadReferralData() {
        const histContainer = document.getElementById('referralPayoutHistory');
        if (histContainer) histContainer.innerHTML = '<span style="color:#888;font-size:12px;">Cargando...</span>';

        try {
            const [meRes, histRes] = await Promise.all([
                fetch(`${VIP.config.API_URL}/api/referrals/me`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                }),
                fetch(`${VIP.config.API_URL}/api/referrals/history?limit=20`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                })
            ]);

            if (!meRes.ok) {
                if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
                return;
            }
            const meData = await meRes.json();
            const me = meData.data;

            document.getElementById('myReferralCode').textContent = me.referralCode || '—';
            document.getElementById('myReferralLink').textContent = me.referralLink || '—';
            const activeCountEl = document.getElementById('referralActiveCount');
            if (activeCountEl) activeCountEl.textContent = me.activeReferred != null ? me.activeReferred : (me.totalReferred || 0);
            document.getElementById('referralHistoricalTotal').textContent =
                '$' + new Intl.NumberFormat('es-AR').format(Math.round(me.historicalTotalCredited || 0));
            document.getElementById('referralCurrentPeriod').textContent = me.currentPeriodLabel || me.currentPeriod || '—';
            // #195: el % que cobra ESTE usuario (acuerdo puntual o el de /sys_referral_pct).
            if (me.referralPct != null && VIP.platform && VIP.platform.applyReferralPct) VIP.platform.applyReferralPct(me.referralPct);

            VIP.state.referralData = me;

            try {
                const sumRes = await fetch(`${VIP.config.API_URL}/api/referrals/summary`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                });
                if (sumRes.ok) {
                    const sumData = await sumRes.json();
                    const sum = sumData.data;
                    document.getElementById('referralPendingAmount').textContent =
                        '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.pendingEstimatedAmount || 0));
                    document.getElementById('referralCreditDate').textContent =
                        sum.estimatedCreditDate || 'Inicio del próximo mes';
                    const lastPayoutEl = document.getElementById('referralLastPayoutAmount');
                    if (lastPayoutEl) {
                        if (sum.lastPayout && sum.lastPayout.amount > 0) {
                            lastPayoutEl.textContent = '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.lastPayout.amount));
                            lastPayoutEl.title = sum.lastPayout.periodLabel || sum.lastPayout.periodKey || '';
                        } else {
                            lastPayoutEl.textContent = '—';
                        }
                    }
                }
            } catch (e) { /* ignorar */ }

            const EMPTY_HISTORY_HTML = '<span style="color:#888;font-size:12px;">Todavía no tenés pagos por referidos.</span>';

            if (histRes.ok) {
                const histData = await histRes.json();
                const payouts  = histData.data?.payouts || [];
                if (payouts.length === 0) {
                    histContainer.innerHTML = EMPTY_HISTORY_HTML;
                } else {
                    const byPeriod = new Map();
                    for (const p of payouts) {
                        const key = p.periodKey || '?';
                        if (!byPeriod.has(key)) byPeriod.set(key, []);
                        byPeriod.get(key).push(p);
                    }

                    const statusBadgeHtml = (status) => {
                        if (status === 'paid')
                            return '<span style="background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.4);color:#00ff88;font-size:10px;border-radius:4px;padding:2px 6px;">✅ Pagado</span>';
                        if (status === 'failed')
                            return '<span style="background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.4);color:#ff4444;font-size:10px;border-radius:4px;padding:2px 6px;">❌ Fallido</span>';
                        if (status === 'cancelled')
                            return '<span style="background:rgba(136,136,136,0.12);border:1px solid rgba(136,136,136,0.4);color:#888;font-size:10px;border-radius:4px;padding:2px 6px;">🚫 Cancelado</span>';
                        return '<span style="background:rgba(247,147,30,0.12);border:1px solid rgba(247,147,30,0.4);color:#f7931e;font-size:10px;border-radius:4px;padding:2px 6px;">⏳ Pendiente</span>';
                    };

                    let html = '';
                    for (const [pk, periodPayouts] of byPeriod) {
                        const label    = periodPayouts[0].periodLabel || pk;
                        const paidTotal = periodPayouts
                            .filter(p => p.status === 'paid')
                            .reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
                        const hasMultiple = periodPayouts.length > 1;

                        html += `<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.05);">`;
                        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
                        html += `<span style="font-size:12px;color:#d4af37;font-weight:600;">📅 ${label}</span>`;
                        if (paidTotal > 0)
                            html += `<span style="font-size:12px;color:#00ff88;font-weight:bold;">$${new Intl.NumberFormat('es-AR').format(Math.round(paidTotal))}</span>`;
                        html += `</div>`;

                        for (const p of periodPayouts) {
                            const isDelta = p.isDelta || (p.payoutIndex || 1) > 1;
                            const amount  = p.totalCommissionAmount || 0;
                            html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;${hasMultiple ? 'padding-left:8px;' : ''}">`;
                            html += `<div style="display:flex;align-items:center;gap:6px;">`;
                            if (isDelta)
                                html += `<span style="background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>`;
                            html += `${statusBadgeHtml(p.status)}`;
                            html += `</div>`;
                            html += `<span style="font-size:13px;color:${p.status === 'paid' ? '#d4af37' : '#888'};font-weight:${p.status === 'paid' ? '600' : 'normal'};">$${new Intl.NumberFormat('es-AR').format(Math.round(amount))}</span>`;
                            html += `</div>`;
                        }
                        html += `</div>`;
                    }
                    histContainer.innerHTML = html;
                }
            } else {
                histContainer.innerHTML = EMPTY_HISTORY_HTML;
            }
        } catch (err) {
            console.error('[Referrals] Error cargando datos:', err);
            if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
        }
    }

    function copyReferralCode() {
        const code = document.getElementById('myReferralCode').textContent;
        if (code && code !== '—') {
            navigator.clipboard.writeText(code).then(() => {
                showToast('✅ Código copiado', 'success');
            }).catch(() => { fallbackCopy(code); });
        }
    }

    function copyReferralLink() {
        const link = document.getElementById('myReferralLink').textContent;
        if (link && link !== '—') {
            navigator.clipboard.writeText(link).then(() => {
                showToast('✅ Link copiado', 'success');
            }).catch(() => { fallbackCopy(link); });
        }
    }

    // ---- Canal informativo (delegated from chat module) ----

    function loadCanalInformativoUrl() {
        return VIP.chat.loadCanalInformativoUrl();
    }

    // ---- PWA install ----

    async function installApp() {
        const ua        = navigator.userAgent;
        const isIOS     = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isAndroid = /Android/.test(ua);
        const isWindows = /Windows/.test(ua);
        const isMac     = /Macintosh|MacIntel/.test(ua) && !isIOS;

        if (!window.deferredPrompt) {
            if (isIOS)          showInstallInstructions('ios');
            else if (isAndroid) showInstallInstructions('android');
            else if (isWindows) showInstallInstructions('windows');
            else if (isMac)     showInstallInstructions('mac');
            else                showInstallInstructions('generic');
            return;
        }

        window.deferredPrompt.prompt();
        const { outcome } = await window.deferredPrompt.userChoice;

        if (outcome === 'accepted') {
            showToast('✅ Instalando app...', 'success');
            // Recordatorio de notificaciones para Android (flujo directo via deferredPrompt)
            setTimeout(() => {
                showInstallInstructions('android-notif');
            }, 2000);
        } else {
            showToast('❌ Instalación cancelada', 'error');
        }
        window.deferredPrompt = null;
    }

    function showInstallInstructions(platform) {
        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';

        let title, steps, note;
        // Plataformas móviles: se muestra el aviso de notificaciones
        const isMobilePlatform = platform === 'ios' || platform === 'android' || platform === 'android-notif';

        // Pantalla dedicada de recordatorio de notificaciones post-instalación (Android nativo)
        if (platform === 'android-notif') {
            modal.innerHTML = `
                <div class="ios-install-content">
                    <h3>🔔 Un paso más</h3>
                    <div style="
                        background: rgba(255, 107, 53, 0.15);
                        border: 2px solid #ff6b35;
                        border-radius: 10px;
                        padding: 14px 16px;
                        text-align: left;
                    ">
                        <p style="margin: 0; color: #ff6b35; font-weight: bold; font-size: 15px;">
                            🔔 LO MÁS IMPORTANTE: PERMITIR NOTIFICACIONES
                        </p>
                        <p style="margin: 10px 0 0; color: #fff; font-size: 13px;">
                            Cuando abras la app instalada y te pida acceso,
                            <strong>aceptá y permitir notificaciones</strong>.<br>
                            Sin esto, <u>no te van a llegar los avisos importantes</u>.
                        </p>
                    </div>
                    <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
                </div>
            `;
            document.body.appendChild(modal);
            return;
        }

        if (platform === 'ios') {
            title = '📱 Instalar en iPhone / iPad';
            note  = '⚠️ <strong>Solo funciona desde Safari.</strong>';
            steps = [
                'Abrí esta página en <strong>Safari</strong> (no Chrome, no otro navegador)',
                'Tocá el botón <strong>Compartir</strong> <span style="font-size:18px">⬆️</span> en la barra inferior de Safari',
                'Deslizá hacia abajo y tocá <strong>"Agregar a pantalla de inicio"</strong>',
                'Presioná <strong>"Agregar"</strong>'
            ];
        } else if (platform === 'android') {
            title = '📱 Instalar en Android';
            note  = '⚠️ <strong>Solo funciona desde Google Chrome.</strong>';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong>',
                'Tocá el ícono <strong>⋮</strong> (tres puntos) en la esquina superior derecha',
                'Seleccioná <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong>',
                'Presioná <strong>"Agregar"</strong> o <strong>"Instalar"</strong>'
            ];
        } else if (platform === 'windows') {
            title = '💻 Instalar en Windows (PC)';
            note  = '💡 Funciona en Chrome o Edge.';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> o <strong>Microsoft Edge</strong>',
                'En Chrome: hacé clic en el ícono de instalación <strong>⊕</strong> en la barra de direcciones',
                'En Edge: hacé clic en el ícono <strong>⊕</strong> o el menú <strong>⋯</strong> → <strong>"Aplicaciones"</strong> → <strong>"Instalar este sitio como aplicación"</strong>',
                'Confirmá la instalación'
            ];
        } else if (platform === 'mac') {
            title = '💻 Instalar en Mac';
            note  = '💡 Funciona en Chrome o Safari.';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> o <strong>Safari</strong>',
                'En Chrome: hacé clic en el ícono <strong>⊕</strong> en la barra de direcciones',
                'En Safari: usá <strong>Archivo → Agregar a Dock</strong> (macOS Sonoma o superior)',
                'Confirmá la instalación'
            ];
        } else {
            title = '📱 Instalar App';
            note  = '';
            steps = [
                'Abrí esta página en <strong>Chrome</strong> o <strong>Safari</strong>',
                'Buscá la opción <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong> en el menú del navegador',
                'Confirmá la instalación'
            ];
        }

        // Aviso de notificaciones destacado para iOS y Android
        const notifWarning = isMobilePlatform ? `
            <div style="
                background: rgba(255, 107, 53, 0.15);
                border: 2px solid #ff6b35;
                border-radius: 10px;
                padding: 12px 15px;
                margin-top: 15px;
                text-align: left;
            ">
                <p style="margin: 0; color: #ff6b35; font-weight: bold; font-size: 14px;">
                    🔔 LO MÁS IMPORTANTE: PERMITIR NOTIFICACIONES
                </p>
                <p style="margin: 8px 0 0; color: #fff; font-size: 13px;">
                    Una vez instalada, cuando la app te pida acceso, <strong>aceptá y permitir notificaciones</strong>.
                    Sin esto, <u>no te van a llegar los avisos importantes</u>.
                </p>
            </div>` : '';

        modal.innerHTML = `
            <div class="ios-install-content">
                <h3>${title}</h3>
                ${note ? `<p style="color: #f7931e; margin-bottom: 12px;">${note}</p>` : ''}
                <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
                ${notifWarning}
                <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
            </div>
        `;
        document.body.appendChild(modal);
    }

    function isAppInstalled() {
        const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                           window.navigator.standalone === true;
        if (!standalone) return false;
        // Also require notification permission to be granted
        const notifGranted = ('Notification' in window) && Notification.permission === 'granted';
        return notifGranted;
    }

    function isAppStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }

    return {
        showModal,
        hideModal,
        showToast,
        copyText,
        copyToClipboard,
        fallbackCopy,
        showLoginScreen,
        showChatScreen,
        adjustLayout,
        syncBalance,
        handleBalancePush,
        showCasinoInvite,
        hideCasinoInvite,
        casinoInviteJoinCommunity,
        casinoInviteAlreadyIn,
        showBalanceToast,
        updateBalanceDisplay,
        startBalancePolling,
        stopBalancePolling,
        sendWelcomeMessages,
        loadAndShowCBU,
        openReferralModal,
        loadReferralData,
        copyReferralCode,
        copyReferralLink,
        loadCanalInformativoUrl,
        installApp,
        showInstallInstructions,
        isAppInstalled,
        isAppStandalone
    };

})();

// Window aliases for onclick="..." in HTML
window.showModal             = VIP.ui.showModal;
window.hideModal             = VIP.ui.hideModal;
window.showToast             = VIP.ui.showToast;
window.copyText              = VIP.ui.copyText;
window.copyToClipboard       = VIP.ui.copyToClipboard;
window.copyReferralCode      = VIP.ui.copyReferralCode;
window.copyReferralLink      = VIP.ui.copyReferralLink;
window.installApp            = VIP.ui.installApp;
window.showInstallInstructions = VIP.ui.showInstallInstructions;

// ---- PWA install prompt event handlers (must be top-level) ----

window.deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
        return;
    }
    window.deferredPrompt = e;
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'flex'; loginInstallBtn.classList.remove('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'flex'; headerInstallBtn.classList.remove('hidden'); }
    if (appInstallBtn)    { appInstallBtn.style.display = 'flex'; appInstallBtn.classList.add('show'); }
});

window.addEventListener('appinstalled', () => {
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
    window.deferredPrompt = null;
    VIP.ui.showToast('✅ App instalada exitosamente', 'success');
});

// Hide install buttons if already running as standalone
if (VIP.ui.isAppStandalone()) {
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
}


// Platform modal — private state (no DOM exposure for sensitive data)
VIP.ui._platformPasswordVisible = false;

VIP.ui._copyUsernameToClipboard = function(username, onSuccess) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(username).then(onSuccess).catch(function() {
      VIP.ui.showToast('👤 Tu usuario: ' + username, 'info');
    });
  } else {
    VIP.ui.showToast('👤 Tu usuario: ' + username, 'info');
  }
};

VIP.ui.openPlatformModal = function() {
  const modal = document.getElementById('platformModal');
  if (!modal) return;
  const username = VIP.state.currentUser?.username || '';
  const userEl = document.getElementById('platformModalUser');
  if (userEl) userEl.textContent = username || 'Usuario';

  // Mostrar contraseña si está disponible en memoria de sesión (sin exponerla en el DOM)
  const pwd = VIP.state.sessionPassword || '';
  VIP.ui._platformPasswordVisible = false;
  const pwdEl = document.getElementById('platformModalPassword');
  const pwdInputSection = document.getElementById('platformPasswordInputSection');
  const pwdToggle = document.getElementById('platformPasswordToggle');
  if (pwdEl) {
    pwdEl.textContent = pwd ? '••••••••' : '—';
    if (pwdToggle) pwdToggle.textContent = '👁';
  }
  if (pwdInputSection) pwdInputSection.style.display = pwd ? 'none' : 'block';

  // Resetear feedback de copia
  const feedback = document.getElementById('platformCopyFeedback');
  if (feedback) feedback.style.display = 'none';

  modal.style.display = 'flex';

  // Auto-copiar usuario al abrir el modal
  if (username) {
    VIP.ui._copyUsernameToClipboard(username, function() {
      if (feedback) feedback.style.display = 'block';
      VIP.ui.showToast('✅ Usuario copiado: ' + username, 'success');
    });
  }
};

VIP.ui.closePlatformModal = function() {
  const modal = document.getElementById('platformModal');
  if (modal) modal.style.display = 'none';
};

VIP.ui.copyPlatformUsername = function() {
  const username = VIP.state.currentUser?.username || '';
  if (!username) return;
  const feedback = document.getElementById('platformCopyFeedback');
  VIP.ui._copyUsernameToClipboard(username, function() {
    if (feedback) feedback.style.display = 'block';
    VIP.ui.showToast('✅ Usuario copiado: ' + username, 'success');
  });
};

// ============================================
// ENTRAR AL CASINO — login único (SSO) contra 1girox
// ============================================
//
// Antes: se abría el casino y el usuario tenía que copiar y pegar su usuario y
// contraseña a mano. Ahora el backend pide un link de acceso directo
// (POST /api/platform/session → 1girox POST /players/{username}/session) y el
// usuario entra ya logueado.
//
// ⚠️ POP-UP BLOCKER: el link viene de un fetch (asíncrono) y los navegadores —sobre
// todo en mobile— bloquean window.open si no ocurre DENTRO del gesto del usuario.
// Por eso la pestaña se abre PRIMERO, vacía, y recién después se le cambia la URL.
// Además el código de acceso vence a los 60 segundos, así que no se cachea nada.
VIP.ui._casinoOpening = false;

/**
 * Abre el casino EMBEBIDO en un recuadro a pantalla completa, dentro de la PWA.
 * El jugador nunca sale de VIPCARGAS: cierra el recuadro con la ✕ y vuelve al chat.
 *
 * Orden de las cosas (importa):
 *   1. Se muestra el recuadro con un "cargando" — INMEDIATO, en el mismo click.
 *   2. Recién ahí se pide el link de acceso al backend.
 *   3. Apenas llega, se carga en el iframe.
 *
 * ⚠️ Por qué se pide el link DESPUÉS de abrir el recuadro y no antes: el código de
 * acceso vence a los 60 SEGUNDOS y es de un solo uso. Cuanto menos tiempo pase entre
 * que la plataforma lo emite y el navegador lo usa, mejor. En conexiones lentas (o por
 * Tor) pedirlo antes y usarlo después llegaba vencido: "El enlace expiró".
 */
VIP.ui._casinoOpen = false;

/**
 * Pide el link SSO al backend con TIMEOUT (AbortController, default 20s).
 *
 * Sin timeout, un fetch colgado en 4G dejaba `_casinoOpening` en true por
 * minutos → en ese lapso el botón CASINO no hacía NADA (el "toco y no entra,
 * recién al segundo toque abre" reportado por los jugadores).
 *
 * @returns {ok:true, url} | {ok:false, error, retryable}
 *   `retryable` solo con 5xx / timeout / red caída — un 4xx (bloqueado, límite
 *   de intentos) no cambia por reintentar.
 */
VIP.ui._fetchCasinoSession = async function(timeoutMs) {
  const ms = Number(timeoutMs) || 20000;
  let controller = null;
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    timer = setTimeout(function () { controller.abort(); }, ms);
  }
  try {
    const response = await fetch(`${VIP.config.API_URL}/api/platform/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VIP.state.currentToken}`
      },
      signal: controller ? controller.signal : undefined
    });
    const data = await response.json().catch(function () { return {}; });
    if (response.ok && data.success && data.redirectUrl) {
      return { ok: true, url: data.redirectUrl };
    }
    return { ok: false, error: data.error || null, retryable: response.status >= 500 };
  } catch (e) {
    // Timeout (abort) o red caída: reintentable.
    return { ok: false, error: null, retryable: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

VIP.ui.enterCasino = async function() {
  // #190 modo manual (GANAMOS sin API): no hay SSO ni iframe (otro dominio, sin
  // sesión compartida). Se abre la página de GANAMOS en una pestaña, DENTRO del
  // gesto del usuario (si no, el bloqueador de pop-ups mobile la mata).
  if (VIP.platform && VIP.platform.isManual()) {
    VIP.ui.closePlatformModal();
    const url = VIP.platform.playUrl();
    const win = window.open(url, '_blank', 'noopener');
    if (!win) window.location.href = url;
    return;
  }
  if (VIP.ui._casinoOpening) return; // anti doble-click
  VIP.ui._casinoOpening = true;

  VIP.ui.closePlatformModal();
  VIP.ui._showCasinoFrame();   // recuadro visible YA, con "cargando"

  try {
    // Hasta 3 intentos ante fallas transitorias (saturación momentánea del
    // carril de la plataforma, parpadeo de red móvil): antes el "reintento"
    // era el propio jugador tocando de nuevo.
    const waits = [0, 1500, 3000];
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!VIP.ui._casinoOpen) return; // salió del casino mientras cargaba
      if (attempt > 0) {
        const status = document.getElementById('casinoFrameStatus');
        if (status) status.textContent = '🔄 Reintentando… (' + (attempt + 1) + '/3)';
        await new Promise(function (r) { setTimeout(r, waits[attempt]); });
        if (!VIP.ui._casinoOpen) return; // salió durante la espera
      }
      last = await VIP.ui._fetchCasinoSession(20000);
      if (last.ok || !last.retryable) break;
    }

    if (last && last.ok) {
      // Si cerró el overlay durante el fetch, NO arrancar el casino oculto
      // (quedaría sonando y consumiendo datos de fondo).
      if (!VIP.ui._casinoOpen) return;
      const frame = document.getElementById('casinoFrame');
      if (frame) frame.src = last.url;

      // VIGILANTE: el `load` del iframe dispara aunque la app de adentro se quede
      // colgada. El caso típico es el BLOQUEO DE COOKIES DE TERCEROS: el casino
      // carga, intenta leer su sesión, el navegador se la niega por estar embebido
      // en otro dominio, y queda girando para siempre. Desde afuera no se puede
      // detectar (es otro origen, no podemos mirar adentro), así que se usa un
      // tiempo límite y se le ofrece al jugador la salida.
      clearTimeout(VIP.ui._casinoWatchdog);
      VIP.ui._casinoWatchdog = setTimeout(function() {
        if (!VIP.ui._casinoOpen) return;
        VIP.ui._casinoFrameStuck();
      }, 15000);
      return;
    }

    VIP.ui._casinoFrameError((last && last.error) ||
      'No pudimos abrirte el casino. Revisá tu internet y tocá Reintentar.');
  } finally {
    VIP.ui._casinoOpening = false;
  }
};

/**
 * Abre el casino en una PESTAÑA APARTE (no embebido).
 *
 * Es la salida cuando el navegador no deja que el casino funcione dentro del
 * recuadro. Al abrirse como sitio principal, sus cookies dejan de ser "de terceros"
 * y la sesión funciona normal.
 *
 * ⚠️ La pestaña se abre ANTES del fetch, dentro del gesto del usuario: si se abriera
 * después, el bloqueador de pop-ups (sobre todo en mobile) la mataría.
 * Y se pide un link NUEVO a propósito: el anterior ya lo consumió el iframe y los
 * códigos son de un solo uso.
 */
VIP.ui.openCasinoInTab = async function() {
  let win = null;
  try {
    win = window.open('', '_blank');
    if (win && win.document) {
      win.document.write(
        '<!doctype html><meta charset="utf-8"><title>Entrando al casino…</title>' +
        '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
        'height:100vh;background:#12101a;color:#d4af37;font-family:system-ui,sans-serif;' +
        'font-size:18px;font-weight:700">🎰 Entrando al casino…</body>'
      );
    }
  } catch (e) { win = null; }

  // Mismo helper con timeout que el flujo embebido, con 1 reintento si la
  // falla es transitoria: la pestaña placeholder ya está abierta DENTRO del
  // gesto del usuario, así que reintentar el fetch no molesta al pop-up blocker.
  let res = await VIP.ui._fetchCasinoSession(20000);
  if (!res.ok && res.retryable) {
    try {
      if (win && !win.closed && win.document && win.document.body) {
        win.document.body.textContent = '🔄 Reintentando…';
      }
    } catch (e) { /* la pestaña puede ser de otro origen ya: ignorar */ }
    await new Promise(function (r) { setTimeout(r, 1500); });
    res = await VIP.ui._fetchCasinoSession(20000);
  }

  if (res.ok) {
    if (win && !win.closed) {
      win.location.href = res.url;
    } else {
      // Pop-up bloqueado → se navega en la pestaña actual.
      window.location.href = res.url;
      return;
    }
    VIP.ui.closeCasinoFrame();
    return;
  }
  if (win && !win.closed) win.close();
  VIP.ui.showToast(res.error || 'No pudimos abrirte el casino. Revisá tu internet e intentá de nuevo.', 'error');
};

/** El casino no terminó de cargar dentro del recuadro: se ofrece abrirlo aparte. */
VIP.ui._casinoFrameStuck = function() {
  const status = document.getElementById('casinoFrameStatus');
  const frame = document.getElementById('casinoFrame');
  if (!status) return;
  // El iframe se deja visible por si en realidad terminó de cargar y sólo tardó:
  // el aviso se muestra encima, sin tapar el juego.
  status.style.display = 'flex';
  status.style.position = 'absolute';
  status.style.inset = 'auto 0 0 0';
  status.style.background = 'rgba(13,13,26,0.96)';
  status.style.padding = '18px';
  status.innerHTML =
    '<div style="color:#ffd479;font-size:15px;font-weight:700;line-height:1.45;max-width:460px;">' +
      '¿El casino no termina de cargar?</div>' +
    '<div style="color:#aaa;font-size:13px;font-weight:400;line-height:1.45;max-width:460px;">' +
      'Tu navegador puede estar bloqueando el casino por estar abierto acá adentro. ' +
      'Abrilo aparte y va a funcionar normal.</div>' +
    '<button type="button" onclick="VIP.ui.openCasinoInTab()" ' +
      'style="background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;border:none;' +
      'padding:12px 26px;border-radius:24px;font-weight:800;font-size:15px;cursor:pointer;">' +
      '↗ Abrir el casino aparte</button>' +
    '<button type="button" onclick="document.getElementById(\'casinoFrameStatus\').style.display=\'none\'" ' +
      'style="background:none;color:#888;border:none;font-size:13px;cursor:pointer;">' +
      'Seguir esperando</button>';
  if (frame) frame.style.display = 'block';
};

/**
 * Crea (una sola vez) y muestra el recuadro del casino.
 *
 * PANTALLA COMPLETA (owner 2026-08-19): el casino embebido se ve TAL CUAL el
 * sitio del casino — sin barra propia arriba. El chrome vive en una burbuja de
 * soporte 🎧 (abajo a la derecha) que abre un WIDGET flotante estilo "chat de
 * soporte" anclado a la esquina: acciones rápidas (depositar/retirar/CBU/
 * comprobante) + el chat REAL de la app mudado adentro (mismos nodos, mismos
 * listeners, mismo socket — el agente lo ve por su bandeja de siempre).
 */
VIP.ui._showCasinoFrame = function() {
  let overlay = document.getElementById('casinoOverlay');

  if (!overlay) {
    // "Carga rápida" y no "Soporte": los clientes confundían el widget nuestro
    // con el soporte propio de la página del casino.
    const MARCA = 'GANAMOS';
    overlay = document.createElement('div');
    overlay.id = 'casinoOverlay';
    // iPhone standalone (viewport-fit=cover + status bar translúcida): el
    // viewport ocupa también el notch y la zona del home indicator. El resto
    // del front compensa con env(safe-area-inset-*) en los CSS; este overlay
    // se arma inline, así que compensa acá (el iframe termina antes del home
    // indicator y arranca debajo del reloj; esas franjas quedan del color del
    // overlay, no blancas). En navegador normal env() vale 0 → cero cambio.
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:#0d0d1a;display:flex;flex-direction:column;' +
      'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);';
    overlay.innerHTML =
      '<div id="casinoFrameStatus" style="flex:1;display:flex;flex-direction:column;gap:14px;' +
        'align-items:center;justify-content:center;color:#d4af37;font-size:16px;font-weight:700;' +
        'text-align:center;padding:20px;">🎰 Entrando al casino…</div>' +
      // `allow` habilita pantalla completa y sonido dentro de los juegos.
      '<iframe id="casinoFrame" title="Casino" style="flex:1;width:100%;border:0;display:none;" ' +
        'allow="autoplay; fullscreen; payment"></iframe>' +

      // ── Burbuja "Carga rápida" (abre/cierra el widget) ──
      // Logo 1GIROX + etiqueta "⚡ CARGA RÁPIDA": con el 🎧 pelado los clientes
      // creían que era el soporte propio de la página del casino. Todo vive
      // DENTRO del button para que al arrastrar se mueva junto.
      '<button type="button" id="casinoSupportBubble" onclick="VIP.ui.toggleCasinoChat()" ' +
        'style="position:absolute;right:16px;bottom:calc(18px + env(safe-area-inset-bottom,0px));' +
        'display:flex;flex-direction:column;align-items:center;gap:4px;padding:0;z-index:6;' +
        'background:none;border:none;cursor:pointer;user-select:none;-webkit-user-select:none;">' +
        '<span style="position:relative;display:block;width:60px;height:60px;">' +
          '<img src="/images/soporte-ganamos.png" alt="Carga rápida GANAMOS" draggable="false" ' +
            'style="width:60px;height:60px;border-radius:50%;object-fit:cover;display:block;' +
            'border:2px solid #00e676;box-shadow:0 6px 22px rgba(0,200,83,0.55);-webkit-user-drag:none;">' +
          '<span id="casinoChatBadge" style="display:none;position:absolute;top:-3px;right:-3px;' +
            'background:#ff3b30;color:#fff;font-size:11px;font-weight:800;min-width:19px;height:19px;' +
            'border-radius:10px;line-height:19px;padding:0 4px;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></span>' +
        '</span>' +
        '<span style="display:block;background:linear-gradient(135deg,#00a844,#00e676);color:#04240f;' +
          'font-size:10px;font-weight:900;letter-spacing:0.3px;padding:3px 8px;border-radius:9px;' +
          'white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,0.45);">⚡ CARGA RÁPIDA</span>' +
      '</button>' +

      // ── Widget flotante (panel anclado a la esquina; el juego sigue visible) ──
      '<div id="casinoChatDrawer" style="display:none;position:absolute;right:16px;' +
        'bottom:calc(88px + env(safe-area-inset-bottom,0px));width:min(380px,calc(100vw - 24px));' +
        'height:min(600px,72vh);flex-direction:column;background:#0d0d1a;' +
        'border:1px solid rgba(212,175,55,0.45);border-radius:16px;overflow:hidden;' +
        'box-shadow:0 18px 60px rgba(0,0,0,0.7);z-index:7;">' +

        // 1. Header verde
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;flex:0 0 auto;' +
          'background:linear-gradient(135deg,#00933c,#00c853);">' +
          '<img src="/images/soporte-ganamos.png" alt="" draggable="false" ' +
            'style="width:38px;height:38px;border-radius:50%;object-fit:cover;flex:0 0 auto;' +
            'border:2px solid rgba(255,255,255,0.35);">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="color:#fff;font-weight:800;font-size:14px;">Carga rápida ' + MARCA + '</div>' +
            '<div style="color:#d8ffe9;font-size:11px;font-weight:700;">' +
              '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#5cff9d;' +
              'box-shadow:0 0 6px #5cff9d;margin-right:4px;"></span>EN LÍNEA</div>' +
          '</div>' +
          '<button type="button" onclick="VIP.ui.toggleCasinoChat()" ' +
            'style="background:rgba(255,255,255,0.18);color:#fff;border:none;width:30px;height:30px;' +
            'border-radius:50%;font-size:15px;cursor:pointer;flex:0 0 auto;">✕</button>' +
        '</div>' +

        // 2. Acciones principales
        '<div style="display:flex;gap:8px;padding:10px 10px 0;flex:0 0 auto;">' +
          '<button type="button" onclick="VIP.ui.casinoQuickAction(\'cargar-toggle\')" ' +
            'style="flex:1;background:linear-gradient(135deg,#00a844,#00e676);color:#04240f;border:none;' +
            'padding:11px 6px;border-radius:11px;font-weight:900;font-size:13px;cursor:pointer;">💰 Quiero Depositar</button>' +
          '<button type="button" onclick="VIP.ui.casinoQuickAction(\'retirar\')" ' +
            'style="flex:1;background:linear-gradient(135deg,#d4af37,#ffd700);color:#241c00;border:none;' +
            'padding:11px 6px;border-radius:11px;font-weight:900;font-size:13px;cursor:pointer;">💸 Solicitar Retiro</button>' +
        '</div>' +

        // 3. Sub-fila de montos (oculta hasta tocar Depositar)
        '<div id="casinoAmountRow" style="display:none;gap:6px;padding:8px 10px 0;flex:0 0 auto;flex-wrap:wrap;">' +
          [2000, 5000, 10000, 20000].map(function (m) {
            return '<button type="button" onclick="VIP.ui.casinoQuickAction(\'cargar\',' + m + ')" ' +
              'style="flex:1;min-width:70px;background:rgba(0,230,118,0.12);color:#5cff9d;' +
              'border:1px solid rgba(0,230,118,0.45);padding:9px 4px;border-radius:9px;' +
              'font-weight:800;font-size:13px;cursor:pointer;">$' + m.toLocaleString('es-AR') + '</button>';
          }).join('') +
        '</div>' +

        // 4. Fila chica de chips (scroll horizontal)
        '<div style="display:flex;gap:6px;padding:8px 10px;overflow-x:auto;flex:0 0 auto;' +
          '-webkit-overflow-scrolling:touch;">' +
          '<button type="button" onclick="VIP.ui.casinoQuickAction(\'cbu\')" ' +
            'style="background:rgba(255,255,255,0.07);color:#ddd;border:1px solid rgba(255,255,255,0.18);' +
            'padding:7px 12px;border-radius:16px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">📋 Pedir CBU</button>' +
          '<button type="button" onclick="VIP.ui.casinoQuickAction(\'comprobante\')" ' +
            'style="background:rgba(255,255,255,0.07);color:#ddd;border:1px solid rgba(255,255,255,0.18);' +
            'padding:7px 12px;border-radius:16px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">✅ Ya transferí</button>' +
          '<button type="button" onclick="VIP.ui.casinoQuickAction(\'escribir\')" ' +
            'style="background:rgba(255,255,255,0.07);color:#ddd;border:1px solid rgba(255,255,255,0.18);' +
            'padding:7px 12px;border-radius:16px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">💬 Hablar</button>' +
        '</div>' +

        // 5. Escapes discretos
        '<div style="display:flex;gap:16px;padding:0 12px 8px;flex:0 0 auto;">' +
          '<a href="javascript:void(0)" onclick="VIP.ui.openCasinoInTab()" ' +
            'style="color:#8a8aa0;font-size:11px;text-decoration:underline;">↗ Casino aparte</a>' +
          '<a href="javascript:void(0)" onclick="VIP.ui.closeCasinoFrame()" ' +
            'style="color:#8a8aa0;font-size:11px;text-decoration:underline;">🚪 Salir del casino</a>' +
        '</div>' +

        // 6. Acá se MUDA el chat real (VIP.ui._casinoChatMount)
        '<div id="casinoChatDrawerBody" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Cuando el casino termina de cargar, se esconde el "cargando", se muestra
    // el juego y SE CANCELA el vigilante: sin esto, el aviso "¿el casino no
    // termina de cargar?" aparecía ENCIMA del casino ya funcionando.
    const frame = overlay.querySelector('#casinoFrame');
    frame.addEventListener('load', function() {
      // Solo cuenta el load del CASINO REAL. Se lee el ATRIBUTO: la PROPIEDAD
      // .src con atributo '' devuelve la URL resuelta (truthy) → el load
      // ESPURIO del src vacío (navegaba a la propia PWA, bloqueada por
      // X-Frame-Options) pasaba el guard viejo y escondía el "Entrando…"
      // antes de que llegara el link SSO (recuadro vacío intermitente).
      const src = frame.getAttribute('src');
      if (!src || src === 'about:blank') return;
      const status = document.getElementById('casinoFrameStatus');
      if (status) status.style.display = 'none';
      frame.style.display = 'block';
      clearTimeout(VIP.ui._casinoWatchdog);
    });

    // Badge de NO LEÍDOS: cuenta los mensajes que llegan al chat mientras el
    // casino está abierto Y el widget cerrado. Se crea una sola vez.
    VIP.ui._casinoUnread = 0;
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages && !VIP.ui._casinoChatObserver) {
      VIP.ui._casinoChatObserver = new MutationObserver(function (mutations) {
        if (!VIP.ui._casinoOpen || VIP.ui._casinoChatOpen) return;
        let added = 0;
        for (const m of mutations) added += (m.addedNodes ? m.addedNodes.length : 0);
        if (!added) return;
        VIP.ui._casinoUnread += added;
        const badge = document.getElementById('casinoChatBadge');
        if (badge) {
          badge.textContent = VIP.ui._casinoUnread > 9 ? '9+' : String(VIP.ui._casinoUnread);
          badge.style.display = 'block';
        }
      });
      VIP.ui._casinoChatObserver.observe(chatMessages, { childList: true });
    }

    // BURBUJA ARRASTRABLE: la burbuja fija tapaba controles de algunos juegos
    // (ej. la botonera de la ruleta) y el jugador no tenía forma de tocar lo que
    // quedaba debajo. Ahora se arrastra con el dedo (o mouse); al soltarla se pega
    // al borde izquierdo o derecho (imán) y queda ahí mientras el casino siga
    // abierto. Un toque SIN arrastre sigue abriendo el chat como siempre.
    (function _makeBubbleDraggable() {
      const b = overlay.querySelector('#casinoSupportBubble');
      if (!b || !window.PointerEvent) return; // sin pointer events → fija como antes
      b.style.touchAction = 'none'; // sin esto, el navegador scrollea en vez de arrastrar
      let startX = 0, startY = 0, startRect = null, dragging = false;
      b.addEventListener('pointerdown', function(e) {
        startX = e.clientX; startY = e.clientY;
        startRect = b.getBoundingClientRect();
        dragging = false;
        try { b.setPointerCapture(e.pointerId); } catch (_) {}
      });
      b.addEventListener('pointermove', function(e) {
        if (!startRect) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        // Umbral tap/arrastre: menos de 8px de movimiento sigue siendo un toque.
        if (!dragging && (Math.abs(dx) + Math.abs(dy)) < 8) return;
        dragging = true;
        const x = Math.min(Math.max(4, startRect.left + dx), window.innerWidth - startRect.width - 4);
        const y = Math.min(Math.max(10, startRect.top + dy), window.innerHeight - startRect.height - 10);
        b.style.left = x + 'px';
        b.style.top = y + 'px';
        b.style.right = 'auto';
        b.style.bottom = 'auto';
      });
      const end = function() {
        if (startRect && dragging) {
          // Imán al borde horizontal más cercano; la altura queda donde la dejó.
          const r = b.getBoundingClientRect();
          const toLeft = (r.left + r.width / 2) < window.innerWidth / 2;
          if (toLeft) { b.style.left = '16px'; b.style.right = 'auto'; }
          else { b.style.left = 'auto'; b.style.right = '16px'; }
          VIP.ui._bubbleSide = toLeft ? 'left' : 'right';
          // El click que dispara el navegador justo después del arrastre NO debe
          // abrir el chat: se marca y se limpia solo a los 400ms (por si el click
          // nunca llega, no queda un toque "muerto").
          VIP.ui._bubbleWasDragged = true;
          setTimeout(function() { VIP.ui._bubbleWasDragged = false; }, 400);
        }
        startRect = null; dragging = false;
      };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
    })();
  }

  // Reset al abrir (por si venía de un intento anterior que falló).
  const frame = overlay.querySelector('#casinoFrame');
  const status = overlay.querySelector('#casinoFrameStatus');
  // ⚠️ 'about:blank', NUNCA '': el string vacío navega el iframe a la URL
  // base (la propia PWA) — request inútil + load espurio que rompía la carga.
  if (frame) { frame.src = 'about:blank'; frame.style.display = 'none'; }
  if (status) { status.style.display = 'flex'; status.textContent = '🎰 Entrando al casino…'; }
  VIP.ui._casinoUnread = 0;
  const badge = overlay.querySelector('#casinoChatBadge');
  if (badge) { badge.style.display = 'none'; badge.textContent = ''; }

  overlay.style.display = 'flex';
  // Bloquea el scroll del fondo mientras el casino está abierto.
  document.body.style.overflow = 'hidden';
  VIP.ui._casinoOpen = true;

  // El widget arranca ABIERTO: así el jugador ve de una que es NUESTRA "Carga
  // rápida 1Girox" y no el soporte de la página del casino (pedido owner). Lo
  // cierra con la ✕ del header o tocando la burbuja, como siempre.
  if (!VIP.ui._casinoChatOpen) { try { VIP.ui._casinoChatMount(); } catch (e) {} }
};

// ── Widget de soporte: abrir/cerrar y mudanza del chat real ──

VIP.ui._casinoChatOpen = false;

VIP.ui.toggleCasinoChat = function() {
  // Si lo que hubo fue un ARRASTRE de la burbuja, el click posterior no abre.
  if (VIP.ui._bubbleWasDragged) return;
  // El panel se abre del MISMO lado en que quedó la burbuja (imán del drag).
  const drawer = document.getElementById('casinoChatDrawer');
  if (drawer) {
    if (VIP.ui._bubbleSide === 'left') { drawer.style.left = '16px'; drawer.style.right = 'auto'; }
    else if (VIP.ui._bubbleSide === 'right') { drawer.style.left = 'auto'; drawer.style.right = '16px'; }
  }
  if (VIP.ui._casinoChatOpen) { VIP.ui._casinoChatUnmount(); VIP.ui._showBubbleDragHintOnce(); }
  else VIP.ui._casinoChatMount();
};

/**
 * Pista de arrastre (una vez por dispositivo): al PRIMER cierre del widget se
 * muestra un globito junto a la burbuja avisando que se puede arrastrar — sin
 * esto nadie descubre que la burbuja se mueve (el pedido vino de un cliente al
 * que le tapaba la botonera de la ruleta).
 */
VIP.ui._showBubbleDragHintOnce = function() {
  try {
    if (localStorage.getItem('casinoBubbleDragHint')) return;
    localStorage.setItem('casinoBubbleDragHint', '1');
  } catch (e) { return; }
  const overlay = document.getElementById('casinoOverlay');
  const b = document.getElementById('casinoSupportBubble');
  if (!overlay || !b) return;
  const r = b.getBoundingClientRect();
  const hint = document.createElement('div');
  hint.textContent = '✋ ¿Te tapa el juego? Mantené apretado y arrastrá la burbuja a donde quieras';
  hint.style.cssText =
    'position:absolute;max-width:230px;background:rgba(13,13,26,0.95);color:#ffd700;' +
    'border:1px solid rgba(212,175,55,0.6);border-radius:12px;padding:9px 12px;' +
    'font-size:12px;font-weight:700;line-height:1.35;z-index:8;' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.6);transition:opacity 0.6s;';
  // Del mismo lado en que está la burbuja, justo arriba de ella.
  if ((r.left + r.width / 2) < window.innerWidth / 2) hint.style.left = '12px';
  else hint.style.right = '12px';
  hint.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  overlay.appendChild(hint);
  setTimeout(function() { hint.style.opacity = '0'; }, 6000);
  setTimeout(function() { try { hint.remove(); } catch (e) {} }, 6800);
};

/**
 * MUDA (no copia) el chat real al widget: inserta placeholders invisibles donde
 * están .chat-container y .chat-input-container y mueve los nodos REALES adentro
 * del drawer. Conservan ids, listeners y socket → es EL MISMO chat; el agente lo
 * ve por su bandeja de siempre, cero cambios de backend/panel.
 */
VIP.ui._casinoChatMount = function() {
  const drawer = document.getElementById('casinoChatDrawer');
  const body = document.getElementById('casinoChatDrawerBody');
  const chatCont = document.querySelector('.chat-container');
  const inputCont = document.querySelector('.chat-input-container');
  if (!drawer || !body || !chatCont || !inputCont) return;

  // Placeholders exactos para devolver los nodos a su lugar al desmontar.
  const ph = function () {
    const s = document.createElement('span');
    s.style.display = 'none';
    return s;
  };
  VIP.ui._casinoChatPh1 = ph();
  VIP.ui._casinoChatPh2 = ph();
  chatCont.parentNode.insertBefore(VIP.ui._casinoChatPh1, chatCont);
  inputCont.parentNode.insertBefore(VIP.ui._casinoChatPh2, inputCont);
  body.appendChild(chatCont);
  body.appendChild(inputCont);

  // Compactación: el widget ya tiene título propio → se oculta la cabecera del
  // chat, y se pisa el min-height del contenedor (guardando el valor previo).
  const topbar = chatCont.querySelector('.chat-topbar');
  if (topbar) { VIP.ui._casinoChatTopbarDisplay = topbar.style.display; topbar.style.display = 'none'; }
  VIP.ui._casinoChatMinHeight = chatCont.style.minHeight;
  chatCont.style.minHeight = '0';

  drawer.style.display = 'flex';
  VIP.ui._casinoChatOpen = true;

  // Badge a cero y scroll al fondo (tras el reflow del appendChild).
  VIP.ui._casinoUnread = 0;
  const badge = document.getElementById('casinoChatBadge');
  if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
  requestAnimationFrame(function () {
    const msgs = document.getElementById('chatMessages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  });
};

/** Devuelve el chat a su lugar exacto y oculta el widget. */
VIP.ui._casinoChatUnmount = function() {
  const drawer = document.getElementById('casinoChatDrawer');
  const chatCont = document.querySelector('.chat-container');
  const inputCont = document.querySelector('.chat-input-container');

  if (chatCont) {
    const topbar = chatCont.querySelector('.chat-topbar');
    if (topbar) topbar.style.display = VIP.ui._casinoChatTopbarDisplay || '';
    chatCont.style.minHeight = VIP.ui._casinoChatMinHeight || '';
    if (VIP.ui._casinoChatPh1 && VIP.ui._casinoChatPh1.parentNode) {
      VIP.ui._casinoChatPh1.replaceWith(chatCont);
    }
  }
  if (inputCont && VIP.ui._casinoChatPh2 && VIP.ui._casinoChatPh2.parentNode) {
    VIP.ui._casinoChatPh2.replaceWith(inputCont);
  }
  VIP.ui._casinoChatPh1 = null;
  VIP.ui._casinoChatPh2 = null;

  if (drawer) drawer.style.display = 'none';
  VIP.ui._casinoChatOpen = false;
};

// ── Acciones rápidas del widget ──
// Todo termina en el chat del cajero (los botones solo ahorran tipeo; el cajero
// sigue confirmando todo — no es un bot).

VIP.ui._casinoSendQuick = function(text) {
  const input = document.getElementById('messageInput');
  if (input) input.value = text;
  try { VIP.chat.sendMessage(); } catch (e) {}
};

VIP.ui.casinoQuickAction = function(action, arg) {
  const amountRow = document.getElementById('casinoAmountRow');
  switch (action) {
    case 'cargar-toggle':
      if (amountRow) amountRow.style.display = amountRow.style.display === 'flex' ? 'none' : 'flex';
      break;
    case 'cargar':
      if (amountRow) amountRow.style.display = 'none';
      VIP.ui._casinoSendQuick('🎰 Quiero cargar $' + (Number(arg) || 0).toLocaleString('es-AR'));
      break;
    case 'cargar-otro': {
      const input = document.getElementById('messageInput');
      if (input) { input.value = '🎰 Quiero cargar $'; input.focus(); }
      break;
    }
    case 'cbu':
      VIP.ui.loadAndShowCBU();
      break;
    case 'comprobante': {
      const attach = document.getElementById('attachBtn');
      if (attach) attach.click();
      break;
    }
    case 'retirar': {
      // FORMULARIO REAL de retiro: antes solo mandaba "quiero retirar" al chat de
      // CARGAS — el pedido nunca llegaba al sector PAGOS. Ahora abre el MISMO modal
      // autogestionado del chat normal (datos bancarios + SMS →
      // /api/withdrawal/request → bandeja de Pagos).
      try {
        if (VIP.withdraw && VIP.withdraw.openWithdrawModal) {
          // El overlay del casino vive en z-index 99999 y los modales en 10000:
          // se eleva el modal para que se vea ENCIMA del casino.
          const m = document.getElementById('withdrawModal');
          if (m) m.style.zIndex = '100001';
          VIP.withdraw.openWithdrawModal();
          break;
        }
      } catch (e) { /* si el módulo no está, cae al mensaje de siempre */ }
      VIP.ui._casinoSendQuick('💸 Quiero retirar mi premio');
      break;
    }
    case 'escribir': {
      const input = document.getElementById('messageInput');
      if (input) input.focus();
      break;
    }
    case 'saldo':
      try { VIP.ui.syncBalance(); } catch (e) {}
      VIP.ui._casinoSendQuick('👛 ¿Me confirmás mi saldo?');
      break;
  }
};

/** Cierra el recuadro y vuelve a la app. */
VIP.ui.closeCasinoFrame = function() {
  clearTimeout(VIP.ui._casinoWatchdog);
  const overlay = document.getElementById('casinoOverlay');
  if (!overlay) return;
  // SIEMPRE des-montar el chat primero: si no, la pantalla principal queda sin chat.
  try { VIP.ui._casinoChatUnmount(); } catch (e) {}
  // Se navega a about:blank para que el casino deje de correr en segundo plano
  // (si no, sigue sonando y consumiendo datos aunque el recuadro esté oculto).
  // ⚠️ 'about:blank', NUNCA '': el string vacío navega el iframe a la URL
  // base (la propia PWA) — request inútil + load espurio que rompía la carga.
  const frame = overlay.querySelector('#casinoFrame');
  if (frame) frame.src = 'about:blank';
  overlay.style.display = 'none';
  document.body.style.overflow = '';
  VIP.ui._casinoOpen = false;

  // Al volver, refrescar el saldo: es muy probable que haya cambiado jugando.
  if (VIP.ui.syncBalance) { try { VIP.ui.syncBalance(); } catch (e) {} }
};

/** Muestra un error dentro del recuadro, con la opción de reintentar o salir. */
VIP.ui._casinoFrameError = function(msg) {
  const status = document.getElementById('casinoFrameStatus');
  if (!status) {
    VIP.ui.showToast(msg, 'error');
    return;
  }
  status.style.display = 'flex';
  status.style.flexDirection = 'column';
  status.style.gap = '14px';
  status.innerHTML =
    '<div style="color:#ff8080;font-weight:700;max-width:420px;line-height:1.45;">' + msg + '</div>' +
    '<button type="button" onclick="VIP.ui.enterCasino()" ' +
      'style="background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;border:none;' +
      'padding:12px 26px;border-radius:24px;font-weight:800;font-size:15px;cursor:pointer;">' +
      '🔄 Reintentar</button>' +
    '<button type="button" onclick="VIP.ui.closeCasinoFrame()" ' +
      'style="background:none;color:#aaa;border:none;font-size:14px;cursor:pointer;">' +
      'Volver a GANAMOS</button>';
};

// El botón "atrás" del celular cierra el recuadro en vez de salir de la app.
window.addEventListener('popstate', function() {
  if (VIP.ui._casinoOpen) VIP.ui.closeCasinoFrame();
});

// Botón "Abrir Casino" DENTRO del modal (que ahora es el camino de respaldo, cuando
// el SSO falló). Abre el casino a secas para que el usuario entre a mano con los
// datos que el modal le muestra.
VIP.ui.goToPlatform = function() {
  window.open(VIP.config.PLATFORM_URL, '_blank');
  VIP.ui.closePlatformModal();
};


VIP.ui.togglePlatformPasswordVisibility = function() {
  const pwdEl = document.getElementById('platformModalPassword');
  const toggle = document.getElementById('platformPasswordToggle');
  if (!pwdEl) return;
  const plain = VIP.state.sessionPassword || '';
  if (!plain) return;
  VIP.ui._platformPasswordVisible = !VIP.ui._platformPasswordVisible;
  if (VIP.ui._platformPasswordVisible) {
    pwdEl.textContent = plain;
    if (toggle) toggle.textContent = '🙈';
  } else {
    pwdEl.textContent = '••••••••';
    if (toggle) toggle.textContent = '👁';
  }
};

VIP.ui.savePlatformPassword = function() {
  const input = document.getElementById('platformPasswordManualInput');
  if (!input || !input.value.trim()) return;
  const pwd = input.value.trim();
  VIP.state.sessionPassword = pwd;
  VIP.ui._platformPasswordVisible = false;
  const pwdEl = document.getElementById('platformModalPassword');
  const pwdInputSection = document.getElementById('platformPasswordInputSection');
  const pwdToggle = document.getElementById('platformPasswordToggle');
  if (pwdEl) {
    pwdEl.textContent = '••••••••';
    if (pwdToggle) pwdToggle.textContent = '👁';
  }
  if (pwdInputSection) pwdInputSection.style.display = 'none';
  input.value = '';
  VIP.ui.showToast('✅ Contraseña guardada para esta sesión', 'success');
};

VIP.ui.showPlatformPasswordChange = function() {
  // Cerrar el modal de plataforma
  VIP.ui.closePlatformModal();
  // Asegurarse de que el cambio sea voluntario (no obligatorio)
  VIP.state.passwordChangePending = false;
  // Preparar y abrir el modal de cambio de contraseña
  if (typeof VIP.auth.prepareChangePasswordModal === 'function') {
    VIP.auth.prepareChangePasswordModal();
  } else if (typeof window.prepareChangePasswordModal === 'function') {
    window.prepareChangePasswordModal();
  }
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.classList.remove('hidden');
};
