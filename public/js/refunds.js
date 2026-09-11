// ========================================
// REFUNDS - Reembolsos module
// ========================================

window.VIP = window.VIP || {};

VIP.refunds = (function () {

    async function loadRefundStatus() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                VIP.state.refundStatus = await response.json();
                updateRefundButtons();
            }
        } catch (error) {
            console.error('Error cargando reembolsos:', error);
        }
        // Nivel VIP en background (no bloquea los reembolsos si la plataforma demora).
        loadVipStatus().catch(() => {});
        // Reembolso EN VIVO (acumulativo de por vida) en background.
        loadCashbackStatus().catch(() => {});
    }

    // ============================================
    // REEMBOLSO EN VIVO — acumulativo de por vida sobre plata REAL
    // (docs/ESPEC-REEMBOLSO-1GIROX.md). Se junta hasta reclamar, al reclamar
    // arranca de 0. El server manda `reclamable` ya calculado.
    // ============================================
    const money = (n) => '$' + (Number(n) || 0).toLocaleString('es-AR');

    async function loadCashbackStatus(fresh) {
        try {
            const url = `${VIP.config.API_URL}/api/cashback/status` + (fresh ? '?fresh=1' : '');
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            const data = await response.json().catch(() => null);
            if (response.status === 429 && data && data.error) {
                if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast(data.error, 'error');
                return VIP.state.cashbackStatus;
            }
            if (response.ok && data) {
                VIP.state.cashbackStatus = data;
                updateCashbackEntry();
            }
        } catch (error) {
            console.error('Error cargando reembolso en vivo:', error);
        }
        return VIP.state.cashbackStatus;
    }

    // Botón en el modal "🎁 Reembolsos": aparece solo si la feature está activa.
    function updateCashbackEntry() {
        const c = VIP.state.cashbackStatus;
        const btn = document.getElementById('unifiedCashbackBtn');
        if (!btn) return;
        if (!c || !c.enabled) { btn.style.display = 'none'; return; }
        btn.style.display = '';
        const pctEl = document.getElementById('unifiedCashbackPct');
        if (pctEl && c.pct) pctEl.textContent = c.pct;
        const ok = c.reclamable > 0 && c.reclamable >= (c.minArs || 0);
        btn.textContent = ok
            ? `📉 Reembolso EN VIVO · ${money(c.reclamable)} para reclamar`
            : `📉 Reembolso EN VIVO (${c.pct || 0}% de lo que perdés, se acumula)`;
    }

    // Recuadro del reembolso en vivo (se usa en el perfil y en el modal propio).
    function cashbackCardHtml(c) {
        if (!c || !c.enabled) return '';
        if (c.unavailable) {
            return `<div style="padding:10px 12px;background:rgba(0,0,0,0.25);border-radius:10px;margin-bottom:8px;font-size:11px;color:#aaa;">
                        📉 Reembolso en vivo: no pudimos calcular tu pérdida ahora. Probá en unos minutos.
                    </div>`;
        }
        const ok = c.reclamable > 0 && c.reclamable >= (c.minArs || 0);
        const detalle = ok
            ? `Tocá RECLAMAR y entra <strong style="color:#fff;">YA</strong> a tu saldo. O seguí juntando: no se vence.`
            : (c.reclamable > 0
                ? `Se reclama desde ${money(c.minArs)}. Seguí jugando: se junta solo.`
                : `Se va juntando solo: el ${c.pct || 0}% de lo que perdés <strong>de tu plata</strong> vuelve acá.`);
        return `<div id="cashbackCard" style="padding:12px;background:rgba(77,208,255,0.08);border:1px solid rgba(77,208,255,0.35);border-radius:10px;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <span style="font-size:12px;font-weight:800;color:#4dd0ff;">📉 Reembolso EN VIVO</span>
                        <span style="font-size:12px;font-weight:900;color:#4dd0ff;">${c.pct || 0}%</span>
                    </div>
                    <div style="text-align:center;margin:6px 0 2px;">
                        <div style="font-size:10.5px;color:#9aa4b0;">TU REEMBOLSO DISPONIBLE</div>
                        <div style="font-size:30px;font-weight:900;color:${ok ? '#4dd0ff' : '#5a6672'};">${money(c.reclamable)}</div>
                    </div>
                    <div style="font-size:11px;color:#aaa;line-height:1.45;text-align:center;">${detalle}</div>
                    <div style="font-size:10.5px;color:#777;margin-top:6px;line-height:1.4;">
                        Pérdida real acumulada: <strong style="color:#ccc;">${money(c.lossLife)}</strong> · ya cobrado: ${money(c.paidLife)}${c.rolloverX > 0 ? ` · para retirarlo apostalo x${c.rolloverX}` : ''}${c.maxDailyArs > 0 ? ` · tope ${money(c.maxDailyArs)} por día` : ''}.
                        Solo cuenta lo que jugás en casino con tu plata (bonos y reembolsos anteriores no suman).
                    </div>
                    <div style="display:flex;gap:8px;margin-top:10px;">
                        ${ok ? `<button type="button" id="cashbackClaimBtn" onclick="VIP.refunds.claimCashback()"
                            style="flex:1;background:linear-gradient(135deg,#1a8fc9,#4dd0ff);color:#04202e;border:none;padding:11px;border-radius:20px;font-weight:900;font-size:13px;cursor:pointer;">
                            💸 RECLAMAR ${money(c.reclamable)}</button>` : ''}
                        <button type="button" onclick="VIP.refunds.refreshCashback()" title="Actualizar"
                            style="${ok ? 'flex:0 0 auto;' : 'flex:1;'}background:rgba(255,255,255,0.08);color:#ddd;border:1px solid rgba(255,255,255,0.15);padding:11px 14px;border-radius:20px;font-weight:800;font-size:12px;cursor:pointer;">🔄 Actualizar</button>
                    </div>
                </div>`;
    }

    // Modal propio (desde el botón del modal "🎁 Reembolsos").
    async function showCashbackModal() {
        let overlay = document.getElementById('cashbackModal');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'cashbackModal';
            overlay.style.cssText =
                'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.85);display:flex;' +
                'align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) closeCashbackModal();
            });
            document.body.appendChild(overlay);
        }
        const render = () => {
            const c = VIP.state.cashbackStatus;
            overlay.innerHTML =
                `<div style="background:linear-gradient(135deg,#1a0033,#2d0052);border:1px solid rgba(77,208,255,0.4);
                            border-radius:16px;max-width:420px;width:100%;padding:18px;max-height:92vh;overflow-y:auto;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                        <span style="font-size:17px;font-weight:900;color:#4dd0ff;">📉 Reembolso en vivo</span>
                        <button type="button" onclick="VIP.refunds.closeCashbackModal()"
                            style="background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1;">×</button>
                    </div>
                    ${c ? cashbackCardHtml(c) : '<div style="color:#aaa;font-size:12px;text-align:center;padding:20px;">Calculando…</div>'}
                    <div style="font-size:11px;color:#999;line-height:1.5;margin-top:10px;">
                        🔄 Te devolvemos un % de lo que perdés jugando <strong>con tu plata</strong> en casino, desde que te registraste. Se acumula hasta que lo reclamás y al reclamarlo arranca de 0.<br>
                        ⚽ Deportes no suma. 🎁 Lo que te regalamos (bonos, ruleta, reembolsos anteriores) no cuenta como pérdida.<br>
                        📆 Lo que cobrás acá se descuenta de tu reembolso diario/semanal/mensual.
                    </div>
                    <button type="button" onclick="VIP.refunds.closeCashbackModal()"
                        style="width:100%;margin-top:14px;background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;
                               border:none;padding:12px;border-radius:22px;font-weight:800;font-size:14px;cursor:pointer;">
                        Cerrar</button>
                </div>`;
        };
        render();
        overlay.style.display = 'flex';
        await loadCashbackStatus();
        if (overlay.style.display !== 'none') render();
    }

    function closeCashbackModal() {
        const overlay = document.getElementById('cashbackModal');
        if (overlay) overlay.style.display = 'none';
    }

    // Repinta el recuadro donde esté abierto (modal propio o perfil).
    async function refreshCashback() {
        await loadCashbackStatus(true);
        const modal = document.getElementById('cashbackModal');
        if (modal && modal.style.display !== 'none') showCashbackModal();
        const profile = document.getElementById('profileModal');
        if (profile && profile.style.display !== 'none') showProfileModal();
    }

    async function claimCashback() {
        const c = VIP.state.cashbackStatus || {};
        const btn = document.getElementById('cashbackClaimBtn');
        if (btn && btn.disabled) return;
        if (!confirm(`¿Reclamar tu reembolso de ${money(c.reclamable)}?\nEntra YA a tu saldo.` +
            (c.rolloverX > 0 ? ` Para retirarlo, apostalo x${c.rolloverX} en casino.` : ''))) return;
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Acreditando…'; }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/cashback/claim`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) {
                if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast(data.error || 'No se pudo reclamar. Probá de nuevo.', 'error');
            } else {
                if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast(`💸 ¡Reembolso de ${money(data.amount)} acreditado en tu saldo!`, 'success');
                if (VIP.ui && VIP.ui.syncBalance) { try { VIP.ui.syncBalance(); } catch (e) {} }
            }
        } catch (error) {
            if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast('Error de conexión. Probá de nuevo.', 'error');
        }
        await loadCashbackStatus();
        // Los reembolsos por período descuentan lo cobrado acá → refrescar.
        loadRefundStatus().catch(() => {});
        const modal = document.getElementById('cashbackModal');
        if (modal && modal.style.display !== 'none') showCashbackModal();
        const profile = document.getElementById('profileModal');
        if (profile && profile.style.display !== 'none') showProfileModal();
    }

    // ============================================
    // NIVEL VIP (apostado acumulado — NO confundir con los rangos de reembolso)
    // ============================================

    async function loadVipStatus() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/vip/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                VIP.state.vipStatus = await response.json();
                updateDashVipBadge();
            }
        } catch (error) {
            console.error('Error cargando nivel VIP:', error);
        }
    }

    // El recuadro USUARIO del dashboard muestra la medalla del nivel en lugar del
    // rótulo genérico. Sin nivel todavía, queda "USUARIO" como siempre.
    function updateDashVipBadge() {
        const v = VIP.state.vipStatus;
        const label = document.querySelector('.dash-user-label');
        if (!label || !v || !v.enabled) return;
        if (v.level) {
            label.textContent = `${v.level.emoji} ${v.level.name.toUpperCase()}`;
            label.title = `Nivel VIP ${v.level.name}`;
        } else {
            label.textContent = 'USUARIO';
        }
    }

    async function claimRakeback() {
        const btn = document.getElementById('vipRakebackBtn');
        if (btn) {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '⏳ Procesando...';
        }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/vip/rakeback/claim`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                }
            });
            const data = await response.json();
            if (data.success) {
                VIP.ui.showToast(`✅ ${data.message}`, 'success');
                if (VIP.ui.syncBalance) VIP.ui.syncBalance();
                // Deja constancia en el chat (mismo patrón que los reembolsos).
                if (VIP.chat && VIP.chat.sendSystemMessage) {
                    VIP.chat.sendSystemMessage(`💸 Rakeback semanal reclamado: $${(data.amount || 0).toLocaleString()}`);
                }
            } else {
                VIP.ui.showToast(`ℹ️ ${data.message}`, 'info');
            }
        } catch (error) {
            VIP.ui.showToast('Error de conexión', 'error');
        }
        // Refrescar y re-dibujar el perfil con el estado nuevo (reclamado o no).
        await loadVipStatus().catch(() => {});
        const overlay = document.getElementById('profileModal');
        if (overlay && overlay.style.display !== 'none') showProfileModal();
    }

    function updateRefundButtons() {
        if (!VIP.state.refundStatus) return;
        updateRefundButton('daily', VIP.state.refundStatus.daily);
        updateRefundButton('weekly', VIP.state.refundStatus.weekly);
        updateRefundButton('monthly', VIP.state.refundStatus.monthly);
        updateRefundLabels();
    }

    // Actualiza los % visibles (tooltips de los botones del dashboard y los spans
    // del modal unificado) con el valor real configurado en el panel.
    function updateRefundLabels() {
        const s = VIP.state.refundStatus;
        if (!s) return;
        const tip = (id, label, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.title = `${label} ${s[t].percentage}%`;
        };
        tip('dailyRefundBtn', 'Reembolso Diario', 'daily');
        tip('weeklyRefundBtn', 'Reembolso Semanal (Lun-Mar)', 'weekly');
        tip('monthlyRefundBtn', 'Reembolso Mensual (Desde día 7)', 'monthly');
        const pctSpan = (id, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.textContent = s[t].percentage;
        };
        pctSpan('unifiedDailyPct', 'daily');
        pctSpan('unifiedWeeklyPct', 'weekly');
        pctSpan('unifiedMonthlyPct', 'monthly');

        // "Información del servicio": el tope de reembolso ya no va hardcodeado
        // en el HTML (los rangos se editan desde el panel) — acá se completa con
        // el % MÁXIMO real de las escaleras que mandó el backend.
        const ladders = s.tiersByPeriod
            ? [s.tiersByPeriod.daily, s.tiersByPeriod.weekly, s.tiersByPeriod.monthly]
            : [s.tiers];
        let maxPct = 0;
        ladders.forEach((ts) => (ts || []).forEach((t) => { if (t && t.pct > maxPct) maxPct = t.pct; }));
        if (maxPct > 0) {
            const setTxt = (id, txt) => {
                const el = document.getElementById(id);
                if (el) el.textContent = txt;
            };
            setTxt('infoRefundsTitle', `Reembolsos hasta ${maxPct}%`);
            setTxt('adRefundsTitle', `Reembolsos hasta ${maxPct}%`);
        }
    }

    function updateRefundButton(type, data) {
        const btn    = document.getElementById(`${type}RefundBtn`);
        const amount = document.getElementById(`${type}RefundAmount`);
        const timer  = document.getElementById(`${type}RefundTimer`);

        amount.textContent = `$${data.potentialAmount.toLocaleString()}`;

        // Etiqueta del % arriba a la derecha del botón. Sale de la pérdida DE ESE
        // período, así que cada reembolso puede tener el suyo. Desde los niveles
        // VIP (2026-08-03) se muestra SOLO el % — los nombres/medallas
        // Bronce/Plata/Oro quedaron exclusivos del nivel VIP para no confundir.
        if (btn && data.tier) {
            let badge = btn.querySelector('.refund-tier');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'refund-tier';
                btn.appendChild(badge);
            }
            badge.textContent = `${data.tier.pct}%`;
            badge.title = `${data.tier.pct}% de reembolso según tu pérdida del período`;
            badge.style.borderColor = data.tier.color;
            badge.style.color = data.tier.color;
        }

        btn.disabled = false;
        btn.classList.remove('claimed');

        if (data.canClaim && data.potentialAmount > 0) {
            timer.textContent = '¡Listo!';
            btn.style.opacity = '1';
        } else {
            btn.style.opacity = '0.7';
            if (data.nextClaim) {
                startCountdown(type, data.nextClaim);
            } else {
                timer.textContent = 'Ver info';
            }
        }
    }

    function startCountdown(type, targetDate) {
        const timerElement = document.getElementById(`${type}RefundTimer`);

        function update() {
            const now    = getArgentinaDate();
            const target = new Date(targetDate);
            const diff   = target - now;

            if (diff <= 0) {
                timerElement.textContent = '¡Listo!';
                loadRefundStatus();
                return;
            }

            const hours   = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 24) {
                timerElement.textContent = `${Math.floor(hours / 24)}d`;
            } else {
                timerElement.textContent = `${hours}h ${minutes}m`;
            }
        }

        update();
        if (VIP.state.refundTimers[type]) clearInterval(VIP.state.refundTimers[type]);
        VIP.state.refundTimers[type] = setInterval(update, 60000);
    }

    async function showRefundModal(type) {

        if (!VIP.state.refundStatus) {
            VIP.ui.showToast('Cargando información de reembolsos...', 'info');
            await loadRefundStatus();
            if (!VIP.state.refundStatus) {
                VIP.ui.showToast('Error: No se pudo cargar la información de reembolsos. Intenta recargar la página.', 'error');
                return;
            }
        }

        const typeData = VIP.state.refundStatus[type];
        // Los porcentajes son configurables desde el panel; los tomamos del estado
        // (campo `percentage` que devuelve /api/refunds/status) en vez de hardcodear.
        const pctOf = (t) => {
            const p = VIP.state.refundStatus[t] && VIP.state.refundStatus[t].percentage;
            return (p !== undefined && p !== null) ? p : { daily: 20, weekly: 10, monthly: 5 }[t];
        };
        const titles = {
            daily:   `📅 Reembolso Diario (${pctOf('daily')}%)`,
            weekly:  `📆 Reembolso Semanal (${pctOf('weekly')}%)`,
            monthly: `🗓️ Reembolso Mensual (${pctOf('monthly')}%)`
        };
        const periodLabels = {
            daily:   '🎮 TU NETWIN DE AYER (pérdida real jugando)',
            weekly:  '🎮 TU NETWIN DE LA SEMANA PASADA (Lun-Dom)',
            monthly: '🎮 TU NETWIN DEL MES PASADO'
        };

        document.getElementById('refundModalTitle').textContent = titles[type];
        document.getElementById('refundMovementsTitle').textContent = periodLabels[type];

        const currentBalance = VIP.state.refundStatus.user?.currentBalance || 0;
        document.getElementById('refundCurrentBalance').textContent = `$${currentBalance.toLocaleString()}`;
        document.getElementById('refundPeriod').textContent = typeData.period || '-';
        document.getElementById('refundNetAmount').textContent = `$${(typeData.netAmount || 0).toLocaleString()}`;
        document.getElementById('refundAmount').textContent = `$${(typeData.potentialAmount || 0).toLocaleString()}`;

        const availabilityInfo = document.getElementById('refundAvailabilityInfo');
        availabilityInfo.style.display = 'none';
        availabilityInfo.innerHTML = '';

        if (type === 'weekly') {
            const today = new Date().getDay();
            const isClaimableDay = today === 1 || today === 2;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Semanal</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable los días <strong>LUNES y MARTES</strong></p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde a la semana anterior (Lunes a Domingo)</p>
                        </div>
                    </div>
                `;
            }
        } else if (type === 'monthly') {
            const today = new Date().getDate();
            const isClaimableDay = today >= 7;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Mensual</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable <strong>después del día 7</strong> de cada mes</p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde al mes anterior completo</p>
                        </div>
                    </div>
                `;
            }
        }

        const extraInfo = document.getElementById('refundExtraInfo');
        const claimBtn  = document.getElementById('claimRefundBtn');
        let isClaimed     = false;
        let timeRemaining = '';

        if (typeData.lastClaim) {
            const lastClaim = new Date(typeData.lastClaim);
            const now = new Date();

            if (type === 'daily') {
                const tomorrow = new Date(lastClaim);
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);
                if (now < tomorrow) {
                    isClaimed = true;
                    const diff = tomorrow - now;
                    const hours   = Math.floor(diff / (1000 * 60 * 60));
                    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    timeRemaining = `${hours}h ${minutes}m`;
                }
            } else if (type === 'weekly') {
                const nextMonday = new Date(lastClaim);
                const daysUntilMonday = (8 - lastClaim.getDay()) % 7 || 7;
                nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
                nextMonday.setHours(0, 0, 0, 0);
                if (now < nextMonday) {
                    isClaimed = true;
                    const diff = nextMonday - now;
                    const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    timeRemaining = `${days}d ${hours}h`;
                }
            } else if (type === 'monthly') {
                const nextMonth = new Date(lastClaim.getFullYear(), lastClaim.getMonth() + 1, 7);
                nextMonth.setHours(0, 0, 0, 0);
                if (now < nextMonth) {
                    isClaimed = true;
                    const diff = nextMonth - now;
                    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                    timeRemaining = `${days}d`;
                }
            }
        }

        if (typeData.potentialAmount <= 0) {
            extraInfo.innerHTML = '<span style="color: #ff8888;">⚠️ No tenés pérdida (NETWIN) en el período. El reembolso es sobre lo que perdiste jugando.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '❌ Sin pérdida para reembolsar';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else if (isClaimed) {
            extraInfo.innerHTML = `<span style="color: #ffaa44;">⏳ Ya reclamaste este reembolso. Disponible en: <strong>${timeRemaining}</strong></span>`;
            claimBtn.disabled = true;
            claimBtn.textContent = `⏳ Disponible en ${timeRemaining}`;
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else if (!typeData.canClaim) {
            extraInfo.innerHTML = '<span style="color: #ffaa44;">⏳ No puedes reclamar este reembolso en este momento.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ No disponible';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else {
            extraInfo.innerHTML = '<span style="color: #00ff88;">✅ ¡Puedes reclamar este reembolso!</span>';
            claimBtn.disabled = false;
            claimBtn.textContent = '🎁 Reclamar Reembolso';
            claimBtn.style.background = '';
        }

        claimBtn.onclick = () => claimRefund(type);

        VIP.ui.showModal('refundModal');
    }

    async function claimRefund(type) {
        const claimBtn = document.getElementById('claimRefundBtn');
        if (claimBtn) {
            if (claimBtn.disabled) return;
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ Procesando...';
        }
        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/claim/${type}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metaEventId })
            });

            const data = await response.json();

            if (data.success) {
                VIP.ui.showToast(`✅ ${data.message}`, 'success');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
                VIP.chat.sendSystemMessage(`🎁 Reembolso ${type} reclamado: $${data.amount.toLocaleString()}`);

                // Meta Pixel — RefundClaim (custom, deduplicado con CAPI).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'RefundClaim', {
                    value: data.amount,
                    currency: 'ARS',
                    content_name: `refund_${type}`
                });
            } else {
                VIP.ui.showToast(`ℹ️ ${data.message}`, 'info');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
            }
        } catch (error) {
            VIP.ui.showToast('Error de conexión', 'error');
        } finally {
            if (claimBtn) {
                claimBtn.disabled = false;
                claimBtn.textContent = '🎁 Reclamar Reembolso';
            }
        }
    }

    async function showUnifiedRefundModal() {
        // Req 3: Precargar el estado de reembolsos ANTES de mostrar el modal unificado,
        // para que al presionar una opción funcione de inmediato sin depender de cargas previas.
        if (!VIP.state.refundStatus) {
            await loadRefundStatus();
        }
        VIP.ui.showModal('unifiedRefundModal');
    }

    // ============================================
    // PERFIL DEL JUGADOR: NIVEL VIP + REEMBOLSOS
    // ============================================

    /**
     * Modal que se abre al tocar el recuadro USUARIO. Muestra el NIVEL VIP (por
     * apostado acumulado, con barra de progreso y rakeback semanal) y los
     * reembolsos por período.
     *
     * ⚠️ Son DOS escalas distintas a propósito:
     *  - Nivel VIP: permanente, sube por apostado de por vida (Bronce…Diamante).
     *  - % de reembolso: POR PERÍODO, sale de la pérdida de ese período puntual y
     *    puede variar entre el diario y el mensual. Se muestra SOLO el % (sin
     *    nombres de rango) para que no se confunda con el nivel VIP.
     */
    async function showProfileModal() {
        if (!VIP.state.refundStatus) {
            await loadRefundStatus();
        }
        if (!VIP.state.vipStatus) {
            await loadVipStatus();
        }
        const s = VIP.state.refundStatus;
        const v = VIP.state.vipStatus;
        const user = VIP.state.currentUser || {};
        const money = (n) => '$' + (Number(n) || 0).toLocaleString('es-AR');

        // ==========================================================
        // Sección NIVEL VIP — versión SIMPLE (owner 2026-08-04): sin números
        // de apuestas ni umbrales a la vista, solo "progreso para ganar $X"
        // (el bono del próximo nivel). El detalle fino de cómo funciona vive
        // en el desplegable de Términos y condiciones, abajo.
        // ==========================================================
        let vipHtml = '';
        let vipLaddersHtml = '';
        if (v && v.enabled) {
            const lvl = v.level;
            const next = v.next;
            const titulo = lvl
                ? `<span style="font-size:15px;font-weight:900;color:${lvl.color};">${lvl.emoji} Nivel ${lvl.name}</span>`
                : `<span style="font-size:14px;font-weight:900;color:#fff;">⭐ Tu camino VIP</span>`;
            const pct = Math.min(100, Math.max(1, Math.round(v.progressPct || 0)));
            const barra = next
                ? `<div style="margin-top:8px;">
                     <div style="font-size:12px;color:#ffd479;font-weight:800;margin-bottom:6px;line-height:1.4;">
                       🎁 Progreso de tu nivel para ganar <span style="color:#ffd700;">${money(next.levelUpBonusArs)}</span>
                     </div>
                     <div style="display:flex;align-items:center;gap:8px;">
                       <div style="flex:1;height:12px;background:rgba(255,255,255,0.09);border-radius:7px;overflow:hidden;">
                         <div style="height:100%;width:${pct}%;
                                     background:linear-gradient(90deg,#d4af37,#ffd700);border-radius:7px;"></div>
                       </div>
                       <span style="font-size:11px;font-weight:900;color:#ffd700;flex-shrink:0;">${pct}%</span>
                     </div>
                     <div style="font-size:10.5px;color:#999;margin-top:5px;">
                       Jugá y tu progreso sube solo. Al llegar a ${next.emoji} ${next.name}, el bono se acredita automáticamente.
                     </div>
                   </div>`
                : `<div style="font-size:11px;color:#7fe07f;margin-top:5px;">¡Estás en el nivel máximo! 👑</div>`;

            // Rakeback semanal: % de lo APOSTADO la semana pasada, gane o pierda.
            let rakeHtml = '';
            const rk = v.rakeback || {};
            if (rk.eligible && rk.claimed) {
                rakeHtml = `<div style="font-size:11px;color:#7fe07f;margin-top:9px;">
                              ✅ Rakeback de esta semana ya reclamado: <strong>${money(rk.amount)}</strong>
                            </div>`;
            } else if (rk.eligible && rk.canClaim) {
                rakeHtml = `<button type="button" id="vipRakebackBtn" onclick="VIP.refunds.claimRakeback()"
                              style="width:100%;margin-top:10px;background:linear-gradient(135deg,#0f4c00,#1a8200);
                                     color:#fff;border:1px solid #00ff88;padding:10px;border-radius:12px;
                                     font-weight:900;font-size:13px;cursor:pointer;">
                              💸 Reclamar rakeback semanal: ${money(rk.amount)}
                            </button>
                            <div style="font-size:10px;color:#999;margin-top:4px;text-align:center;">
                              ${rk.pct}% de lo que apostaste la semana pasada, ganes o pierdas
                            </div>`;
            } else if (rk.eligible) {
                rakeHtml = `<div style="font-size:11px;color:#999;margin-top:9px;">
                              💸 Rakeback semanal: ${rk.pct}% de lo que apostás (lun a dom), ganes o pierdas.
                              La semana pasada no registrás apuestas.
                            </div>`;
            } else {
                rakeHtml = `<div style="font-size:11px;color:#999;margin-top:9px;">
                              💸 El <strong>rakeback semanal</strong> (te devolvemos un % de TODO lo que
                              apostás, ganes o pierdas) se destraba al llegar a 🥉 Bronce.
                            </div>`;
            }

            // Escalera completa (viene del backend, no se duplica acá). Vive DENTRO
            // de los Términos y condiciones — no a la vista (pedido del owner).
            const curIdx = v.levelIndex || 0;
            vipLaddersHtml = (v.levels || []).map((l) => {
                const alcanzado = l.idx <= curIdx;
                return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;
                            padding:7px 10px;background:rgba(255,255,255,${alcanzado ? '0.08' : '0.03'});
                            border-radius:8px;border-left:3px solid ${l.color};
                            ${alcanzado ? '' : 'opacity:0.75;'}">
                            <span style="font-size:11.5px;font-weight:800;color:#fff;white-space:nowrap;">
                                ${l.emoji} ${l.name}${alcanzado ? ' ✓' : ''}</span>
                            <span style="font-size:9.5px;color:#aaa;flex:1;text-align:center;">
                                ${money(l.thresholdArs)} apostados</span>
                            <span style="font-size:10px;font-weight:900;color:${l.color};white-space:nowrap;">
                                +${money(l.levelUpBonusArs)} · ${l.rakebackPct}%</span>
                        </div>`;
            }).join('');

            const terminos = `
                <details style="margin-top:10px;">
                    <summary style="cursor:pointer;font-size:11px;color:#999;font-weight:700;
                                    -webkit-tap-highlight-color:rgba(212,175,55,.2);">
                        📄 Términos y condiciones — cómo funciona el nivel VIP
                    </summary>
                    <div style="margin-top:8px;font-size:11px;color:#bbb;line-height:1.55;">
                        <p style="margin:0 0 8px;">
                            • Tu progreso sube con <strong>todo lo que apostás en el casino</strong>,
                            ganes o pierdas. Se acumula de por vida y <strong>nunca baja</strong>.</p>
                        <p style="margin:0 0 8px;">
                            • Al completar el progreso subís de nivel y el <strong>bono se acredita
                            automáticamente</strong> en tu cuenta. Cada nivel paga más que el anterior.</p>
                        <p style="margin:0 0 8px;">
                            • Desde 🥉 Bronce destrabás el <strong>rakeback semanal</strong>: todas las
                            semanas te devolvemos un % de lo que apostaste la semana anterior (lunes a
                            domingo), ganes o pierdas. El % crece con tu nivel.</p>
                        <p style="margin:0 0 10px;">
                            • Cuenta solo el juego de casino. El apostado se actualiza
                            periódicamente, puede demorar unos minutos en reflejarse.</p>
                        <div style="font-size:11.5px;font-weight:800;color:#d4af37;margin-bottom:6px;">Escalera completa</div>
                        <div style="display:flex;flex-direction:column;gap:5px;">${vipLaddersHtml}</div>
                    </div>
                </details>`;

            vipHtml = `
                <div style="font-size:13px;font-weight:800;color:#d4af37;margin-bottom:8px;">👑 Tu nivel VIP</div>
                <div style="padding:12px;background:rgba(0,0,0,0.3);border-radius:10px;margin-bottom:14px;
                            border:1px solid rgba(212,175,55,0.25);">
                    ${titulo}
                    ${barra}
                    ${rakeHtml}
                    ${terminos}
                </div>`;
        }

        // ==========================================================
        // Reembolsos por período (muestran SOLO el %: los nombres de
        // rango quedaron exclusivos del nivel VIP)
        // ==========================================================
        // Escaleras: desde 2026-08-05 cada período puede tener la SUYA (editable
        // en el panel). Si el backend nuevo manda tiersByPeriod se usan esas; si
        // no (backend viejo cacheado), cae a la única `tiers` de siempre.
        const _tierRows = (tiers) => (tiers || []).map((t) => {
            const rango = t.max === null
                ? `más de ${money(t.max === null ? t.min : t.max)}`
                : (t.min === 0 ? `hasta ${money(t.max)}` : `${money(t.min)} a ${money(t.max)}`);
            return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;
                        padding:9px 12px;background:rgba(255,255,255,0.04);border-radius:9px;
                        border-left:3px solid ${t.color};">
                        <span style="font-size:11px;color:#aaa;flex:1;">Si perdés ${rango}</span>
                        <span style="font-size:14px;font-weight:900;color:${t.color};">${t.pct}%</span>
                    </div>`;
        }).join('');
        const tbp = (s && s.tiersByPeriod) || null;
        const _sameLadder = tbp &&
            JSON.stringify(tbp.daily) === JSON.stringify(tbp.weekly) &&
            JSON.stringify(tbp.daily) === JSON.stringify(tbp.monthly);
        let tiersHtml;
        if (!tbp || _sameLadder) {
            // Una sola tabla (las 3 escaleras son iguales o backend viejo).
            tiersHtml = _tierRows((tbp && tbp.daily) || (s && s.tiers) || []);
        } else {
            // Escaleras distintas: una mini-tabla por período.
            const bloque = (label, tiers) =>
                `<div style="font-size:11px;font-weight:800;color:#d4af37;margin:4px 0 2px;">${label}</div>` +
                _tierRows(tiers);
            tiersHtml = bloque('📅 Diario', tbp.daily) +
                bloque('🗓️ Semanal', tbp.weekly) +
                bloque('📆 Mensual', tbp.monthly);
        }

        // Estado por período: % actual + cuánto falta para el % siguiente.
        const periodo = (label, d) => {
            if (!d || !d.tier) return '';
            const t = d.tier;
            const falta = t.faltaParaSubir != null && t.next
                ? `<div style="font-size:11px;color:#ffd479;margin-top:3px;">
                     Te faltan <strong>${money(t.faltaParaSubir)}</strong> de pérdida para el ${t.next.pct}%
                   </div>`
                : `<div style="font-size:11px;color:#7fe07f;margin-top:3px;">¡Estás en el porcentaje máximo! 🎉</div>`;
            return `<div style="padding:10px 12px;background:rgba(0,0,0,0.25);border-radius:10px;margin-bottom:8px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                            <span style="font-size:12px;font-weight:800;color:#d4af37;">${label}</span>
                            <span style="font-size:12px;font-weight:900;color:${t.color};">${t.pct}%</span>
                        </div>
                        <div style="font-size:11px;color:#aaa;margin-top:3px;">
                            Perdiste ${money(d.netAmount)} · te corresponden <strong style="color:#7fe07f;">${money(d.potentialAmount)}</strong>
                        </div>
                        ${falta}
                    </div>`;
        };

        let overlay = document.getElementById('profileModal');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'profileModal';
            overlay.style.cssText =
                'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.85);display:flex;' +
                'align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) VIP.refunds.closeProfileModal();
            });
            document.body.appendChild(overlay);
        }

        overlay.innerHTML =
            `<div style="background:linear-gradient(135deg,#1a0033,#2d0052);border:1px solid rgba(212,175,55,0.4);
                        border-radius:16px;max-width:420px;width:100%;padding:18px;max-height:92vh;overflow-y:auto;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                    <span style="font-size:17px;font-weight:900;color:#d4af37;">👤 Mi perfil</span>
                    <button type="button" onclick="VIP.refunds.closeProfileModal()"
                        style="background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1;">×</button>
                </div>

                <div style="background:rgba(0,0,0,0.3);border-radius:10px;padding:12px;margin-bottom:14px;">
                    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;">
                        <span style="color:#aaa;font-size:12px;">Usuario</span>
                        <span style="color:#fff;font-size:12px;font-weight:800;">${user.username || '—'}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:8px;">
                        <span style="color:#aaa;font-size:12px;">Saldo</span>
                        <span style="color:#7fe07f;font-size:12px;font-weight:800;">${money((s && s.user && s.user.currentBalance) || user.balance || 0)}</span>
                    </div>
                </div>

                ${vipHtml}

                <div style="font-size:13px;font-weight:800;color:#d4af37;margin-bottom:8px;">🎁 Tus reembolsos</div>
                ${cashbackCardHtml(VIP.state.cashbackStatus)}
                <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.45;">
                    Cuanto más perdés en un período, mayor es el porcentaje que te devolvemos.
                    El porcentaje se calcula por separado en cada reembolso.
                </div>
                ${periodo('📅 Diario', s && s.daily)}
                ${periodo('🗓️ Semanal', s && s.weekly)}
                ${periodo('📆 Mensual', s && s.monthly)}

                <div style="font-size:13px;font-weight:800;color:#d4af37;margin:14px 0 8px;">Escala de reembolsos</div>
                <div style="display:flex;flex-direction:column;gap:6px;">${tiersHtml}</div>

                <button type="button" onclick="VIP.refunds.closeProfileModal()"
                    style="width:100%;margin-top:16px;background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;
                           border:none;padding:12px;border-radius:22px;font-weight:800;font-size:14px;cursor:pointer;">
                    Cerrar</button>
            </div>`;
        overlay.style.display = 'flex';
    }

    function closeProfileModal() {
        const overlay = document.getElementById('profileModal');
        if (overlay) overlay.style.display = 'none';
    }

    return {
        loadRefundStatus,
        loadVipStatus,
        claimRakeback,
        updateRefundButtons,
        updateRefundButton,
        startCountdown,
        showRefundModal,
        claimRefund,
        showUnifiedRefundModal,
        showProfileModal,
        closeProfileModal,
        loadCashbackStatus,
        showCashbackModal,
        closeCashbackModal,
        refreshCashback,
        claimCashback
    };

})();

// Window aliases
window.showRefundModal = VIP.refunds.showRefundModal;
window.claimRefund     = VIP.refunds.claimRefund;
