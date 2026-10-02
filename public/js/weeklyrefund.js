// =====================================================================
// REEMBOLSO SEMANAL (#215, GANAMOS sin API)
// El admin sube la planilla de la semana y el server calcula el reembolso
// de cada cliente (neto = cargas − retiros → rango → %). Acá el cliente ve
// el detalle y lo RECLAMA dentro del plazo; un agente lo carga a mano en
// GANAMOS y al marcarlo entregado le llega el aviso por el chat.
//   - Cartel en el home (#weeklyRefundBanner) cuando hay algo por reclamar
//     o reclamado esperando al agente.
//   - Ítem "Reembolsos" del menú ☰ (con el monto si hay algo por reclamar).
//   - Pantalla con el detalle de cada semana + cómo se calcula.
// Endpoints: GET /api/weekly-refund/status · POST /api/weekly-refund/claim
// =====================================================================
(function () {
    'use strict';
    window.VIP = window.VIP || {};

    let _st = null;          // último status del server
    let _loadedAt = 0;
    let _lastTry = 0;
    let _loading = false;
    let _claiming = false;
    let _boundSocket = null;
    let _forUser = '';

    const _money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
    const _esc = (s) => { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; };
    const _toast = (m, t) => { try { VIP.ui.showToast(m, t || 'info'); } catch (e) { /* sin toast */ } };

    function _left(ms) {
        if (!(ms > 0)) return '0 min';
        const min = Math.floor(ms / 60000);
        const d = Math.floor(min / 1440);
        const h = Math.floor((min % 1440) / 60);
        const m = min % 60;
        if (d > 0) return d + ' d ' + h + ' h';
        if (h > 0) return h + ' h ' + m + ' min';
        return Math.max(1, m) + ' min';
    }
    function _fecha(d) {
        try { return new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    }
    function _msLeft(it) { return it && it.expiresAt ? new Date(it.expiresAt).getTime() - Date.now() : 0; }
    // Por reclamar y todavía en plazo (el server los vence solo; esto evita mostrar uno recién vencido).
    function _pending() {
        return ((_st && _st.items) || []).filter((i) => i.status === 'claim_pending' && _msLeft(i) > 0);
    }
    function _waiting() {
        return ((_st && _st.items) || []).filter((i) => i.status === 'claimed');
    }

    async function load(force) {
        if (!VIP.state || !VIP.state.currentToken) return;
        if (_loading) return;
        if (!force && Date.now() - _loadedAt < 20000) { _render(); return; }
        _loading = true;
        _lastTry = Date.now();
        try {
            const r = await fetch(VIP.config.API_URL + '/api/weekly-refund/status', {
                headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken }
            });
            if (r.ok) {
                _st = await r.json();
                _loadedAt = Date.now();
                _forUser = (VIP.state.currentUser && VIP.state.currentUser.username) || '';
            }
        } catch (e) { /* best-effort: queda lo último que se sabía */ }
        _loading = false;
        _render();
    }

    function _render() {
        _renderBanner();
        _renderMenu();
        if (document.getElementById('weeklyRefundModal')) _paintModal();
    }

    function _renderBanner() {
        const el = document.getElementById('weeklyRefundBanner');
        if (!el) return;
        const pend = _pending();
        const wait = _waiting();
        if (!pend.length && !wait.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
        let html;
        if (pend.length) {
            const total = pend.reduce((s, i) => s + (Number(i.amount) || 0), 0);
            const first = pend[0];
            html = '<div onclick="VIP.weeklyRefund.open()" style="display:flex;align-items:center;gap:8px;cursor:pointer;background:linear-gradient(135deg,#0f5132,#1a8f55);border:2px solid #7dffb0;border-radius:12px;padding:8px 10px;box-shadow:0 3px 12px rgba(37,211,102,0.35);">'
                + '<span style="font-size:22px;flex:none;">💸</span>'
                + '<div style="flex:1;min-width:0;">'
                + '<strong style="display:block;font-size:12.5px;line-height:1.25;color:#fff;">¡Tenés ' + _money(total) + ' de reembolso para reclamar!</strong>'
                + '<span style="display:block;font-size:10.5px;line-height:1.3;color:#d6ffe6;">Semana ' + _esc(first.label) + ' · vence en ' + _left(_msLeft(first)) + '</span>'
                + '</div>'
                + '<button type="button" style="background:#fff;color:#0f5132;border:none;border-radius:9px;padding:8px 11px;font-weight:900;font-size:12px;cursor:pointer;flex-shrink:0;white-space:nowrap;">💸 Reclamar</button>'
                + '</div>';
        } else {
            const total = wait.reduce((s, i) => s + (Number(i.amount) || 0), 0);
            html = '<div onclick="VIP.weeklyRefund.open()" style="display:flex;align-items:center;gap:8px;cursor:pointer;background:rgba(37,211,102,0.10);border:1px solid rgba(37,211,102,0.45);border-radius:12px;padding:7px 10px;">'
                + '<span style="font-size:18px;flex:none;">⏳</span>'
                + '<div style="flex:1;min-width:0;font-size:11.5px;line-height:1.35;color:#d6ffe6;"><strong style="color:#7dffb0;">Reembolso de ' + _money(total) + ' reclamado.</strong> Un agente te lo está cargando en GANAMOS.</div>'
                + '</div>';
        }
        el.innerHTML = html;
        el.style.display = 'block';
    }

    function _renderMenu() {
        const b = document.getElementById('weeklyRefundMenuBadge');
        if (!b) return;
        const pend = _pending();
        if (pend.length) {
            b.textContent = _money(pend.reduce((s, i) => s + (Number(i.amount) || 0), 0)) + ' para reclamar';
            b.style.display = 'inline';
        } else b.style.display = 'none';
    }

    function _row(label, value, strong) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.07);font-size:12.5px;">'
            + '<span style="color:#bbb;">' + label + '</span>'
            + '<span style="color:' + (strong ? '#7dffb0' : '#fff') + ';font-weight:' + (strong ? '900' : '700') + ';text-align:right;">' + value + '</span></div>';
    }

    function _itemCard(it) {
        const left = _msLeft(it);
        const pendiente = it.status === 'claim_pending' && left > 0;
        const vencido = it.status === 'expired' || (it.status === 'claim_pending' && left <= 0);
        let estado;
        if (pendiente) {
            estado = '<div style="margin-top:10px;font-size:11.5px;color:#ffd479;text-align:center;">⏰ Tenés <strong>' + _left(left) + '</strong> para reclamarlo (vence el ' + _fecha(it.expiresAt) + ')</div>'
                + '<button type="button" onclick="VIP.weeklyRefund.claim(\'' + _esc(it.id) + '\', this)" style="display:block;width:100%;margin-top:8px;padding:13px;border:none;border-radius:11px;background:linear-gradient(135deg,#1a9c5b,#25d366);color:#fff;font-size:15px;font-weight:900;cursor:pointer;-webkit-tap-highlight-color:rgba(37,211,102,.3);touch-action:manipulation;">💸 RECLAMAR ' + _money(it.amount) + '</button>';
        } else if (it.status === 'claimed') {
            estado = '<div style="margin-top:10px;padding:9px;border-radius:9px;background:rgba(37,211,102,0.12);border:1px solid rgba(37,211,102,0.4);font-size:12px;color:#d6ffe6;text-align:center;line-height:1.45;">✅ <strong>Reclamado</strong>' + (it.claimedAt ? ' el ' + _fecha(it.claimedAt) : '') + '.<br>En unos minutos un agente te lo carga en tu usuario de GANAMOS y te avisamos por el chat.</div>';
        } else if (it.status === 'delivered') {
            estado = '<div style="margin-top:10px;padding:9px;border-radius:9px;background:rgba(37,211,102,0.18);border:1px solid #25d366;font-size:12px;color:#7dffb0;text-align:center;font-weight:800;">✅ Acreditado en tu usuario de GANAMOS' + (it.deliveredAt ? ' el ' + _fecha(it.deliveredAt) : '') + '</div>';
        } else if (vencido) {
            estado = '<div style="margin-top:10px;padding:9px;border-radius:9px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);font-size:12px;color:#aaa;text-align:center;">⌛ Venció sin reclamar' + (it.expiresAt ? ' (el plazo era hasta el ' + _fecha(it.expiresAt) + ')' : '') + '</div>';
        } else {
            estado = '<div style="margin-top:10px;padding:9px;border-radius:9px;background:rgba(255,120,80,0.10);border:1px solid rgba(255,120,80,0.4);font-size:12px;color:#ffb199;text-align:center;">⚠️ No se pudo entregar. Escribinos por el chat y lo revisamos.</div>';
        }
        const sube = (pendiente || it.status === 'claimed') && it.falta > 0 && it.nextTierName
            ? '<div style="margin-top:6px;font-size:10.5px;color:#999;text-align:center;">Te faltaron ' + _money(it.falta) + ' para el rango ' + _esc(it.nextTierName) + '.</div>' : '';
        return '<div style="background:rgba(0,0,0,0.30);border:1px solid ' + (pendiente ? '#7dffb0' : 'rgba(212,175,55,0.30)') + ';border-radius:13px;padding:12px;margin-bottom:10px;">'
            + '<div style="font-size:12px;font-weight:900;color:#d4af37;letter-spacing:.3px;margin-bottom:4px;">📅 SEMANA ' + _esc(it.label) + '</div>'
            + _row('💵 Cargaste' + (it.count ? ' (' + it.count + ' carga' + (it.count === 1 ? '' : 's') + ')' : ''), _money(it.depositos))
            + _row('🏧 Retiraste', _money(it.retiros))
            + _row('📈 Neto', _money(it.neto))
            + _row('🏷 Rango', _esc(it.tierName || '') + ' · ' + it.pct + '%')
            + _row('💸 Tu reembolso', _money(it.amount), true)
            + estado + sube
            + '</div>';
    }

    function _tiersHtml() {
        const tiers = (_st && _st.tiers) || [];
        if (!tiers.length) return '';
        const horas = (_st && _st.claimHours) || 48;
        const plazo = horas % 24 === 0 ? (horas / 24) + ' día' + (horas / 24 === 1 ? '' : 's') : horas + ' horas';
        return '<div style="background:rgba(212,175,55,0.07);border:1px solid rgba(212,175,55,0.30);border-radius:13px;padding:12px;">'
            + '<div style="font-size:12px;font-weight:900;color:#d4af37;margin-bottom:6px;">¿CÓMO FUNCIONA?</div>'
            + '<div style="font-size:11.5px;color:#ccc;line-height:1.5;margin-bottom:8px;">Cada semana sumamos lo que <strong>cargaste</strong> y le restamos lo que <strong>retiraste</strong>. Según ese neto te corresponde un porcentaje:</div>'
            + tiers.map((t) => '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.07);font-size:12px;"><span style="color:#fff;font-weight:800;">' + _esc(t.name) + '</span><span style="color:#bbb;">desde ' + _money(t.min) + '</span><span style="color:#7dffb0;font-weight:900;">' + t.pct + '%</span></div>').join('')
            + '<div style="font-size:11px;color:#aaa;line-height:1.5;margin-top:8px;">Cuando esté listo te avisamos por acá. Tenés <strong style="color:#ffd479;">' + plazo + '</strong> para tocar RECLAMAR; después un agente te lo carga en tu usuario de GANAMOS.</div>'
            + '</div>';
    }

    function _paintModal() {
        const body = document.getElementById('weeklyRefundBody');
        if (!body) return;
        if (!_st) { body.innerHTML = '<div style="text-align:center;color:#aaa;padding:24px;font-size:13px;">⏳ Cargando…</div>'; return; }
        const items = _st.items || [];
        let html = '';
        if (!items.length) {
            html += '<div style="text-align:center;padding:14px 8px 16px;color:#ccc;font-size:13px;line-height:1.5;">Todavía no tenés reembolsos para reclamar.<br><span style="color:#888;font-size:11.5px;">Cuando calculemos el de la semana te avisamos por el chat.</span></div>';
        } else {
            html += items.map(_itemCard).join('');
        }
        html += _tiersHtml();
        body.innerHTML = html;
    }

    function open() {
        try { document.getElementById('mainMenu') && document.getElementById('mainMenu').classList.add('hidden'); } catch (e) {}
        close();
        const overlay = document.createElement('div');
        overlay.id = 'weeklyRefundModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99998;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
        overlay.innerHTML = '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:2px solid #d4af37;border-radius:18px;padding:18px 14px;max-width:440px;width:100%;color:#fff;margin:16px auto;box-shadow:0 0 40px rgba(212,175,55,0.25);">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">'
            + '<h2 style="margin:0;font-size:17px;color:#ffd700;letter-spacing:.5px;">💸 Reembolso semanal</h2>'
            + '<button type="button" onclick="VIP.weeklyRefund.close()" aria-label="Cerrar" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:50%;width:32px;height:32px;font-size:15px;cursor:pointer;">✕</button>'
            + '</div>'
            + '<div id="weeklyRefundBody"></div>'
            + '</div>';
        document.body.appendChild(overlay);
        _paintModal();
        load(true);
    }

    function close() {
        const m = document.getElementById('weeklyRefundModal');
        if (m) m.remove();
    }

    async function claim(id, btn) {
        if (_claiming) return;
        _claiming = true;
        if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = '⏳ Reclamando…'; }
        try {
            const r = await fetch(VIP.config.API_URL + '/api/weekly-refund/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + VIP.state.currentToken },
                body: JSON.stringify({ id: id })
            });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.success) _toast('✅ ¡Reembolso reclamado! En unos minutos un agente te lo carga.', 'success');
            else _toast(d.error || 'No se pudo reclamar. Probá de nuevo.', 'error');
        } catch (e) {
            _toast('Error de conexión. Probá de nuevo.', 'error');
        }
        _claiming = false;
        await load(true);
    }

    // El server avisa por socket cuando hay un reembolso nuevo o cuando se entregó.
    function _bindSocket() {
        const s = VIP.state && VIP.state.socket;
        if (!s || s === _boundSocket) return;
        _boundSocket = s;
        try { s.on('weekly_refund', function () { load(true); }); } catch (e) { /* nunca romper el socket */ }
    }

    // Arranque: no depende de auth.js — espera la sesión, carga y se mantiene al día
    // (cada 5 min con la app a la vista; el cartel repinta la cuenta regresiva cada 30 s).
    setInterval(function () {
        if (!VIP.state || !VIP.state.currentToken) { if (_st) { _st = null; _loadedAt = 0; _render(); } return; }
        _bindSocket();
        const me = (VIP.state.currentUser && VIP.state.currentUser.username) || '';
        if (me !== _forUser) { _st = null; _loadedAt = 0; _lastTry = 0; _forUser = me; _render(); }
        if (document.hidden) return;
        if (Date.now() - _lastTry < 15000) return; // si falló, no insistir cada 3 s
        if (!_loadedAt || Date.now() - _loadedAt > 5 * 60 * 1000) load(true);
    }, 3000);
    setInterval(function () { if (_st && !document.hidden) _render(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && _loadedAt && Date.now() - _loadedAt > 60000) load(true); });

    VIP.weeklyRefund = { load: load, open: open, close: close, claim: claim };
})();
