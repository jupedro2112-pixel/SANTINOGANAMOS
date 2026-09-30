// =====================================================================
// RULETA DIARIA — 1 giro/día por user con PWA + notifs activadas
// =====================================================================
// Flujo:
//   1) Al cargar el home, fetch /api/roulette/status
//      - si NO elegible (sin FCM token) → no muestra nada
//      - si elegible y ya giró HOY → card mostrando resultado de hoy
//      - si elegible y NO giró → card "GIRAR LA RULETA"
//   2) Click "GIRAR" → abre modal con animación de ruleta, llama
//      POST /api/roulette/spin, muestra premio. Si gana, JUGAYGANA ya
//      acreditó server-side automático.
//   3) Transparencia: tabla de probabilidades visible en el modal
//      ("el premio más grande es el menos probable").
// =====================================================================
(function () {
    'use strict';
    window.VIP = window.VIP || {};

    let _state = null; // { eligible, alreadySpun, spin, prizes }
    let _spinning = false;
    // #201 RUEDA REAL (SVG): ángulo actual del rotor (persistente en la sesión) para
    // que, ya girada, la rueda quede clavada en el premio que salió.
    // #204 Ícono propio de la ruleta (mini rueda SVG) en vez del emoji 🎰.
    const _MINI_WHEEL = '<svg viewBox="0 0 40 40" width="{S}" height="{S}" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex:none;"><circle cx="20" cy="20" r="18.5" fill="#0a0015"/><circle cx="20" cy="20" r="17.5" fill="none" stroke="#d4af37" stroke-width="3"/><path d="M20 20 L20.00 4.50 A15.5 15.5 0 0 1 30.96 9.04 Z" fill="#5b1a8c"/><path d="M20 20 L30.96 9.04 A15.5 15.5 0 0 1 35.50 20.00 Z" fill="#a3172d"/><path d="M20 20 L35.50 20.00 A15.5 15.5 0 0 1 30.96 30.96 Z" fill="#0f7a4f"/><path d="M20 20 L30.96 30.96 A15.5 15.5 0 0 1 20.00 35.50 Z" fill="#1d2e8f"/><path d="M20 20 L20.00 35.50 A15.5 15.5 0 0 1 9.04 30.96 Z" fill="#8a5a12"/><path d="M20 20 L9.04 30.96 A15.5 15.5 0 0 1 4.50 20.00 Z" fill="#0f6c7a"/><path d="M20 20 L4.50 20.00 A15.5 15.5 0 0 1 9.04 9.04 Z" fill="#7a1a5e"/><path d="M20 20 L9.04 9.04 A15.5 15.5 0 0 1 20.00 4.50 Z" fill="#2f5f1a"/><circle cx="20" cy="20" r="15.5" fill="none" stroke="rgba(0,0,0,.35)" stroke-width=".8"/><circle cx="20" cy="20" r="4.2" fill="#1a0033" stroke="#ffd700" stroke-width="1.4"/><polygon points="20,0.5 24,7.5 16,7.5" fill="#ffd700" stroke="#6b4e00" stroke-width=".8"/></svg>';
    function _miniWheel(size) { return _MINI_WHEEL.split('{S}').join(String(size)); }
    let _wheelAngle = null;
    const _WHEEL_COLORS = ['#5b1a8c', '#a3172d', '#0f7a4f', '#1d2e8f', '#8a5a12', '#0f6c7a', '#7a1a5e', '#2f5f1a', '#6b1f1f', '#1f4d6b'];

    // Gajos de la rueda: uno por premio configurado en el panel (mismo orden).
    function _wheelSegments() {
        const list = Array.isArray(_state && _state.prizes) ? _state.prizes.filter(p => p) : [];
        return list.length ? list : [{ label: 'SIN PREMIO', emoji: '😔', type: 'none', value: 0 }];
    }
    // Ángulo (grados, desde arriba, sentido horario) del centro del gajo i.
    function _segCenter(i, n) { return (i + 0.5) * 360 / n; }
    // Índice del gajo que corresponde a un spin (por etiqueta; si no, por tipo+valor; si no, un "sin premio").
    function _segIndexFor(sp) {
        const segs = _wheelSegments();
        if (!sp) return -1;
        const type = sp.prizeType || (Number(sp.prizeARS) > 0 ? 'cash' : 'none');
        const val = type === 'percent' ? Number(sp.prizePct) : Number(sp.prizeARS);
        let cands = segs.map((p, i) => i).filter(i => segs[i].label && sp.prizeLabel && segs[i].label === sp.prizeLabel && (segs[i].type || 'none') === type);
        if (!cands.length) cands = segs.map((p, i) => i).filter(i => (segs[i].type || 'none') === type && (type === 'none' || Number(segs[i].value) === val));
        if (!cands.length) cands = segs.map((p, i) => i).filter(i => (segs[i].type || 'none') === type);
        if (!cands.length) return -1;
        return cands[Math.floor(Math.random() * cands.length)];
    }
    // Rotación del rotor para que el gajo i quede bajo el puntero (arriba). `jitter` en grados.
    function _angleForSeg(i, jitter) {
        const n = _wheelSegments().length;
        if (i < 0) return 0;
        return ((360 - _segCenter(i, n) + (jitter || 0)) % 360 + 360) % 360;
    }
    function _segLines(p) {
        const label = String(p.label || '').trim();
        if ((p.type || 'none') === 'none') return [label || 'SIN PREMIO', ''];
        if (p.type === 'percent') return [label || ('+' + p.value + '%'), 'PRÓX. CARGA'];
        return [label || ('$' + _fmt(p.value)), 'EN FICHAS'];
    }
    // #202 Trébol dorado (SVG) para el resultado sin premio.
    function _cloverSvg() {
        return '<svg viewBox="0 0 64 64" width="58" height="58" xmlns="http://www.w3.org/2000/svg">' +
            '<defs><linearGradient id="rwClv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe680"/><stop offset="1" stop-color="#c9971a"/></linearGradient></defs>' +
            '<circle cx="32" cy="32" r="30" fill="rgba(255,215,0,0.08)" stroke="rgba(255,215,0,0.45)" stroke-width="1.5"/>' +
            '<g fill="url(#rwClv)"><circle cx="32" cy="20" r="8"/><circle cx="44" cy="32" r="8"/><circle cx="32" cy="44" r="8"/><circle cx="20" cy="32" r="8"/></g>' +
            '<circle cx="32" cy="32" r="4" fill="#1a0033"/>' +
            '<path d="M32 44 L36 58" stroke="url(#rwClv)" stroke-width="3" stroke-linecap="round" fill="none"/>' +
            '</svg>';
    }
    function _polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    // SVG completo de la rueda. `angle` = rotación inicial del rotor. `winIdx` resalta un gajo.
    function _wheelSvg(angle, winIdx) {
        const segs = _wheelSegments();
        const n = segs.length;
        const C = 200, R = 168;
        let g = '';
        for (let i = 0; i < n; i++) {
            const a0 = i * 360 / n, a1 = (i + 1) * 360 / n;
            const [x0, y0] = _polar(C, C, R, a0), [x1, y1] = _polar(C, C, R, a1);
            const large = (a1 - a0) > 180 ? 1 : 0;
            const color = _WHEEL_COLORS[i % _WHEEL_COLORS.length];
            const path = n === 1
                ? '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="' + color + '"/>'
                : '<path d="M ' + C + ' ' + C + ' L ' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A ' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' Z" fill="' + color + '" stroke="rgba(255,215,0,0.55)" stroke-width="1.2"/>';
            const mid = _segCenter(i, n);
            const lines = _segLines(segs[i]);
            // #205 El texto se ajusta al ancho del gajo: banda radial entre el hub (r=34) y el
            // aro (r=168) con margen → largo útil 108. Sin emoji dentro de la rueda.
            const BAND = 92;
            const fs1 = Math.max(11, Math.min(19, Math.floor(BAND / (0.62 * Math.max(4, lines[0].length)))));
            const fs2 = 10;
            // Texto radial. Mitad derecha: lee del centro hacia afuera. Mitad izquierda: se
            // da vuelta (rotate +180, anclado al final) para que nunca quede cabeza abajo.
            const leftHalf = mid > 180;
            // #202 el texto va CENTRADO en el gajo (a mitad de camino entre el centro y el aro).
            const TR = 112; // #205 centro VISUAL de la banda (el hub con su aro ocupa hasta r≈40; el aro interior está en r≈160)
            const txTransform = leftHalf
                ? 'translate(' + C + ' ' + C + ') rotate(' + (mid + 90).toFixed(2) + ') translate(-' + TR + ' 0)'
                : 'translate(' + C + ' ' + C + ') rotate(' + (mid - 90).toFixed(2) + ') translate(' + TR + ' 0)';
            g += '<g class="rw-seg' + (i === winIdx ? ' win' : '') + '">' + path +
                '<text transform="' + txTransform + '" fill="#fff" font-family="Arial, Helvetica, sans-serif" font-weight="900" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:rgba(0,0,0,0.55);stroke-width:3px;letter-spacing:.5px;">' +
                '<tspan x="0" y="' + (lines[1] ? -3.5 : 0) + '" font-size="' + fs1 + '">' + _esc(lines[0]) + '</tspan>' +
                (lines[1] ? '<tspan x="0" y="11" font-size="' + fs2 + '" fill="#ffe28a">' + _esc(lines[1]) + '</tspan>' : '') +
                '</text></g>';
        }
        // Luces del aro (24), alternadas.
        let bulbs = '';
        for (let k = 0; k < 24; k++) {
            const [bx, by] = _polar(C, C, 183, k * 15);
            bulbs += '<circle class="rw-bulb ' + (k % 2 ? 'odd' : 'even') + '" cx="' + bx.toFixed(2) + '" cy="' + by.toFixed(2) + '" r="4.6" fill="' + (k % 2 ? '#fff4b3' : '#ffd700') + '"/>';
        }
        return '<div class="rw-wrap" id="rouletteWheelWrap">' +
            '<svg class="rw-svg" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
            '<defs>' +
              '<radialGradient id="rwGlow" cx="50%" cy="50%" r="50%"><stop offset="60%" stop-color="rgba(255,215,0,0)"/><stop offset="100%" stop-color="rgba(255,215,0,0.35)"/></radialGradient>' +
              '<linearGradient id="rwRim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0a8"/><stop offset=".35" stop-color="#d4af37"/><stop offset=".65" stop-color="#8a6a12"/><stop offset="1" stop-color="#ffd700"/></linearGradient>' +
              '<linearGradient id="rwHub" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1a45"/><stop offset="1" stop-color="#0a0015"/></linearGradient>' +
              '<clipPath id="rwHubClip"><circle cx="200" cy="200" r="26"/></clipPath>' +
            '</defs>' +
            '<circle cx="200" cy="200" r="198" fill="url(#rwGlow)"/>' +
            '<circle cx="200" cy="200" r="190" fill="#120a1e"/>' +
            '<g class="rw-rotor" id="rouletteRotor" style="transform-box:view-box;transform-origin:200px 200px;transform:rotate(' + (Number(angle) || 0) + 'deg);">' + g +
              '<circle cx="200" cy="200" r="' + R + '" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="3"/>' +
            '</g>' +
            '<circle cx="200" cy="200" r="183" fill="none" stroke="url(#rwRim)" stroke-width="16"/>' +
            '<circle cx="200" cy="200" r="174.5" fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="2"/>' +
            '<circle cx="200" cy="200" r="191.5" fill="none" stroke="rgba(0,0,0,0.5)" stroke-width="2"/>' +
            bulbs +
            '<circle cx="200" cy="200" r="34" fill="url(#rwHub)" stroke="url(#rwRim)" stroke-width="5"/>' +
            '<image href="/images/soporte-ganamos.png" xlink:href="/images/soporte-ganamos.png" x="174" y="174" width="52" height="52" clip-path="url(#rwHubClip)" preserveAspectRatio="xMidYMid slice"/>' +
            '<g class="rw-pointer"><polygon points="200,4 218,42 182,42" fill="#ffd700" stroke="#7a5a00" stroke-width="2"/><polygon points="200,14 210,38 190,38" fill="#fff4b3"/><circle cx="200" cy="10" r="7" fill="#ffd700" stroke="#7a5a00" stroke-width="2"/></g>' +
            '</svg></div>';
    }
    const _WHEEL_CSS = '<style>' +
        '.rw-wrap{position:relative;width:min(86vw,340px);margin:0 auto 12px;}' +
        '.rw-svg{width:100%;height:auto;display:block;filter:drop-shadow(0 10px 26px rgba(0,0,0,.65)) drop-shadow(0 0 18px rgba(255,215,0,.18));}' +
        '.rw-rotor{will-change:transform;}' +
        '.rw-rotor.idle{animation:rwIdle .55s linear infinite;}' +
        '@keyframes rwIdle{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
        '.rw-bulb{animation:rwBlink 1.4s ease-in-out infinite;}' +
        '.rw-bulb.odd{animation-delay:.7s;}' +
        '.rw-wrap.spinning .rw-bulb{animation-duration:.22s;}' +
        '.rw-seg.win path{filter:brightness(1.45) saturate(1.2);stroke:#fff;stroke-width:2.5px;}' +
        '.rw-seg.win text{fill:#fff;}' +
        '@keyframes rwBlink{0%,100%{opacity:1;filter:drop-shadow(0 0 3px #ffd700)}50%{opacity:.28;filter:none}}' +
        '.rw-btn{width:100%;background:linear-gradient(180deg,#ffe066,#f2b600);color:#1a0033;border:none;padding:16px;border-radius:14px;font-weight:900;font-size:19px;cursor:pointer;letter-spacing:2px;box-shadow:0 6px 18px rgba(255,215,0,.45), inset 0 -3px 0 rgba(0,0,0,.18);transition:transform .08s ease;}' +
        '.rw-btn:active{transform:scale(.98);}' +
        '.rw-btn[disabled]{opacity:.7;cursor:default;}' +
        '</style>';

    function _esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }
    function _fmt(n) { return Number(n || 0).toLocaleString('es-AR'); }

    async function loadStatus() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/roulette/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const d = await r.json();
            if (!d || !d.success) return;
            const prevSpinId = _state && _state.spin && _state.spin.id;
            _state = d;
            if (!d.spin || (prevSpinId && d.spin.id !== prevSpinId)) _wheelAngle = null; // #201 nuevo día / nuevo giro → recalcular
            renderHomeCard();
        } catch (e) { /* best-effort */ }
    }

    function renderHomeCard() {
        const c = document.getElementById('rouletteHomeCard');
        if (!c) return;
        if (!_state || !_state.eligible) {
            // #197: sin la app instalada (con notificaciones) la celda se muestra
            // BLOQUEADA y al tocarla explica los pasos (antes desaparecía y el
            // cliente no sabía que existía la ruleta).
            if (_state && _state.needsAppNotifs) {
                c.innerHTML = '<div class="dash-roulette" style="opacity:.7;" onclick="VIP.roulette && VIP.roulette.needsApp()">'
                    + '<span class="dash-roulette-avatar">🔒</span>'
                    + '<span class="dash-roulette-label">RULETA</span>'
                    + '<span class="dash-roulette-sub">Instalá la app</span>'
                    + '</div>';
                c.style.display = '';
                const sep0 = document.getElementById('rouletteRecentWinnersCard');
                if (sep0) sep0.style.display = 'none';
                return;
            }
            // #188: si le faltan cargas, se muestra la celda BLOQUEADA con lo que
            // le falta (antes desaparecía y el cliente no sabía por qué).
            if (_state && _state.needsActive && _state.minCargas > 0) {
                const faltan = Math.max(1, (_state.minCargas + 1) - (Number(_state.cargas30d) || 0));
                c.innerHTML = '<div class="dash-roulette" style="opacity:.55;" onclick="VIP.ui&&VIP.ui.showToast&&VIP.ui.showToast(\'🎰 La ruleta diaria es para clientes activos: necesitás más de ' + _state.minCargas + ' cargas en los últimos ' + (_state.minCargasDays || 30) + ' días (llevás ' + (Number(_state.cargas30d) || 0) + ').\',\'info\')">'
                    + '<span class="dash-roulette-avatar">🔒</span>'
                    + '<span class="dash-roulette-label">RULETA</span>'
                    + '<span class="dash-roulette-sub">Faltan ' + faltan + ' carga' + (faltan === 1 ? '' : 's') + '</span>'
                    + '</div>';
                c.style.display = '';
            } else {
                c.style.display = 'none';
                c.innerHTML = '';
            }
            // Ocultar tambien el card separado por si quedo de antes.
            const sep = document.getElementById('rouletteRecentWinnersCard');
            if (sep) sep.style.display = 'none';
            return;
        }

        const spin = _state.spin;
        const open = _state.openPrize; // #197 premio de otro día todavía abierto
        // Celda compacta con el mismo formato que el recuadro de usuario
        // (avatar dorado + etiqueta + estado). Tap → modal de spin.
        let subText;
        const subFor = (sp) => {
            const won = Number(sp.prizeARS || 0) > 0;
            const isPct = sp.prizeType === 'percent' && Number(sp.prizePct) > 0;
            if (sp.status === 'claim_pending') return '¡RECLAMÁ!';
            if (sp.status === 'expired') return 'Venció';
            if (isPct && sp.status === 'percent_pending') return '+' + sp.prizePct + '% próx. carga';
            if (isPct && sp.status === 'percent_used') return '% aplicado';
            if (won && sp.status === 'claimed') return 'Cargando…';
            if (won && sp.status === 'credited') return 'Ganaste $' + _fmt(sp.prizeARS);
            if (won && sp.status === 'credit_failed') return 'Escribinos';
            return null;
        };
        if (open && ['claim_pending', 'claimed', 'percent_pending'].includes(open.status) && !(_state.alreadySpun && spin && subFor(spin) && spin.status !== 'no_prize')) {
            subText = subFor(open);
        } else if (_state.alreadySpun && spin) {
            const msN = _state.nextSpinAt ? (new Date(_state.nextSpinAt).getTime() - Date.now()) : 0;
            subText = subFor(spin) || (msN > 0 ? 'En ' + _msLeftText(msN) : 'Volvé pronto'); // #208
        } else if (spin && subFor(spin) && Number(_state.spinsLeft) > 0) {
            subText = subFor(spin); // #200 ganó y todavía le quedan giros
        } else {
            subText = Number(_state.spinsLeft) > 1 ? _state.spinsLeft + ' GIROS HOY' : '¡GIRÁ HOY!';
        }

        c.innerHTML = '<div class="dash-roulette" onclick="VIP.roulette && VIP.roulette.open()">'
            + '<span class="dash-roulette-avatar dash-roulette-avatar-svg">' + _miniWheel(30) + '</span>'
            + '<span class="dash-roulette-label">RULETA</span>'
            + '<span class="dash-roulette-sub">' + _esc(subText) + '</span>'
            + '</div>';
        c.style.display = '';

        // Ocultamos el card SEPARADO (el viejo).
        const sep = document.getElementById('rouletteRecentWinnersCard');
        if (sep) sep.style.display = 'none';
    }


    // Modal que se abre cuando el server rebota el giro porque al user
    // le faltan los pasos (app instalada o notifs). Detecta plataforma y
    // muestra el siguiente paso concreto + CTA.
    function _showNeedsAppModal() {
        const inApp = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                       window.navigator.standalone === true;
        const notifPerm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';

        document.getElementById('rouletteNeedsAppModal')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'rouletteNeedsAppModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99998;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        let b1, b2, b3, ctaTxt, ctaAction;
        if (!inApp) {
            b1 = '⏳'; b2 = '⏳'; b3 = '⏳';
            ctaTxt = '📲 INSTALAR LA APP AHORA';
            ctaAction = 'window.VIP&&VIP.ui&&VIP.ui.installApp&&VIP.ui.installApp();document.getElementById(\'rouletteNeedsAppModal\').remove();';
        } else if (notifPerm !== 'granted') {
            b1 = '✅'; b2 = '✅'; b3 = '⏳';
            ctaTxt = '🔔 ACTIVAR NOTIFICACIONES';
            ctaAction = '(async()=>{try{const p=await Notification.requestPermission();if(p===\'granted\')VIP.ui.showToast(\'✅ Listo, tocá GIRAR de nuevo\',\'success\');}catch(_){}document.getElementById(\'rouletteNeedsAppModal\').remove();})();';
        } else {
            b1 = '✅'; b2 = '✅'; b3 = '⚠️';
            ctaTxt = '🔄 REFRESCAR';
            ctaAction = 'location.reload();';
        }

        overlay.innerHTML =
            '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:2.5px solid #ffd700;border-radius:18px;padding:22px 18px;max-width:440px;width:100%;color:#fff;margin:16px auto;box-shadow:0 0 40px rgba(255,215,0,0.40);">' +
                '<div style="text-align:center;font-size:54px;line-height:1;margin-bottom:6px;">🎰</div>' +
                '<div style="text-align:center;color:#ffd700;font-weight:900;font-size:17px;letter-spacing:1px;margin-bottom:4px;">Para girar la ruleta</div>' +
                '<div style="text-align:center;color:#fff;font-size:13.5px;line-height:1.55;margin-bottom:14px;">Necesitamos asegurarnos que sos vos. Para participar tenés que tener <strong>la app instalada con notificaciones activas</strong>.</div>' +
                '<div style="background:rgba(255,215,0,0.06);border:1px dashed rgba(255,215,0,0.45);border-radius:12px;padding:14px;margin-bottom:14px;">' +
                    '<div style="color:#ffd700;font-weight:900;font-size:11px;letter-spacing:1.5px;text-align:center;margin-bottom:10px;">🧭 SEGUÍ ESTOS 3 PASOS</div>' +
                    '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:9px;"><div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;">' + b1 + '</div><div style="flex:1;font-size:12.5px;line-height:1.5;"><strong>Instalá la app</strong> en tu celular (Android: 1 toque · iPhone: video paso a paso).</div></div>' +
                    '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:9px;"><div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;">' + b2 + '</div><div style="flex:1;font-size:12.5px;line-height:1.5;"><strong>Abrí la app desde el ícono</strong> nuevo de tu pantalla — no desde Chrome.</div></div>' +
                    '<div style="display:flex;gap:10px;align-items:flex-start;"><div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;">' + b3 + '</div><div style="flex:1;font-size:12.5px;line-height:1.5;"><strong>Aceptá las notificaciones</strong> cuando te lo pida la app. Después tocá GIRAR.</div></div>' +
                '</div>' +
                (!inApp ? '<div style="background:rgba(37,211,102,0.10);border:1px solid #25d366;border-radius:10px;padding:9px 11px;margin-bottom:12px;text-align:center;font-size:12px;color:#aaffaa;">🎁 <strong style="color:#ffd700;">Bonus:</strong> al instalar la app te llevás un <strong style="color:#ffd700;">' + _esc(_installBonusShort()) + '</strong> en tu próxima carga.</div>' : '') +
                '<button onclick="' + ctaAction + '" style="width:100%;background:linear-gradient(135deg,#ffd700,#ff8800);color:#000;border:none;padding:13px;border-radius:11px;font-weight:900;font-size:14px;cursor:pointer;letter-spacing:0.5px;margin-bottom:8px;box-shadow:0 4px 14px rgba(255,215,0,0.40);">' + ctaTxt + '</button>' +
                '<button onclick="document.getElementById(\'rouletteNeedsAppModal\').remove();" style="width:100%;background:transparent;color:#aaa;border:1px solid rgba(255,255,255,0.20);padding:10px;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;">Cerrar</button>' +
            '</div>';
        document.body.appendChild(overlay);
    }

    // Card que aparece cuando el user ganó: lo invita a la comunidad para
    // recibir novedades (problemas de página, juegos de la semana,
    // problemas con el banco) y le aclara qué hacer si su WhatsApp
    // principal no funciona — revisar el número vigente en el home.
    function _communityRecommendCard() {
        const link = (window.VIP && VIP.state && VIP.state.communityLink) || '';
        const link2 = (window.VIP && VIP.state && VIP.state.communityLink2) || '';
        const label1 = (window.VIP && VIP.state && VIP.state.communityLabel) || 'COMUNIDAD 1';
        const label2 = (window.VIP && VIP.state && VIP.state.communityLabel2) || 'COMUNIDAD 2';

        let buttons = '';
        if (link) {
            buttons += '<a href="' + _esc(link) + '" target="_blank" rel="noopener" onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button\',\'' + _esc(link) + '\')" style="display:flex;align-items:center;gap:9px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;text-decoration:none;padding:11px 13px;border-radius:10px;font-weight:900;font-size:13.5px;margin-bottom:8px;box-shadow:0 3px 10px rgba(37,211,102,0.40);">' +
                '<span style="font-size:18px;">💬</span>' +
                '<span style="flex:1;text-align:left;">ENTRAR A ' + _esc(label1.toUpperCase()) + '</span>' +
                '<span style="font-size:14px;">›</span>' +
            '</a>';
        }
        if (link2) {
            buttons += '<a href="' + _esc(link2) + '" target="_blank" rel="noopener" onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button_2\',\'' + _esc(link2) + '\')" style="display:flex;align-items:center;gap:9px;background:linear-gradient(135deg,#00d4ff,#0080ff);color:#000;text-decoration:none;padding:11px 13px;border-radius:10px;font-weight:900;font-size:13.5px;margin-bottom:8px;box-shadow:0 3px 10px rgba(0,212,255,0.35);">' +
                '<span style="font-size:18px;">💬</span>' +
                '<span style="flex:1;text-align:left;">ENTRAR A ' + _esc(label2.toUpperCase()) + '</span>' +
                '<span style="font-size:14px;">›</span>' +
            '</a>';
        }
        if (!buttons) return '';

        let html = '<div style="background:linear-gradient(135deg,rgba(34,160,217,0.14),rgba(0,136,204,0.08));border:1.5px dashed rgba(34,160,217,0.55);border-radius:13px;padding:13px;margin-bottom:12px;">';
        html += '<div style="color:#22a0d9;font-weight:900;font-size:12px;letter-spacing:0.8px;text-align:center;margin-bottom:6px;">📢 UNITE A NUESTRA NUEVA COMUNIDAD</div>';
        html += '<div style="color:#fff;font-size:12.5px;line-height:1.5;margin-bottom:10px;text-align:center;">Nos mudamos a <strong>Telegram</strong> — ya no usamos WhatsApp. Sumate al canal privado para enterarte de <strong>códigos, novedades, juegos de la semana</strong> y todo lo que liberamos.</div>';
        html += buttons;
        html += '<div style="background:rgba(255,170,102,0.10);border-left:3px solid #ffaa66;border-radius:0 7px 7px 0;padding:7px 10px;margin-top:6px;color:#ffd0a0;font-size:11.5px;line-height:1.4;">⚠️ Si nuestro <strong>WhatsApp principal</strong> no te funciona, revisá el número vigente abajo en el home.</div>';
        html += '</div>';
        return html;
    }

    // #188 texto corto de la regla del bono por instalar (viene de installbonus.js).
    function _installBonusShort() {
        const r = (window.VIP && VIP.state && VIP.state.installBonusRule) || null;
        if (!r) return '100% de bono';
        return r.pct + '% de bono' + (r.capArs > 0 ? ' (hasta $' + _fmt(r.capArs) + (r.excessPct > 0 ? ', +' + r.excessPct + '% sobre el resto' : '') + ')' : '');
    }

    function open() {
        const modal = document.getElementById('rouletteModal');
        if (!modal) return;
        if (!_state) { loadStatus(); }
        _renderModal();
        modal.style.display = 'flex';
    }

    function close() {
        const modal = document.getElementById('rouletteModal');
        if (modal) modal.style.display = 'none';
    }

    // #208 "Tu próximo giro: en 5 h 12 min (a las 14:30)" a partir de nextSpinAt.
    function _nextSpinText() {
        const at = _state && _state.nextSpinAt ? new Date(_state.nextSpinAt) : null;
        if (!at || isNaN(at.getTime())) return 'Tu próximo giro se habilita 24 h después del último.';
        const ms = at.getTime() - Date.now();
        if (ms <= 0) return 'Ya podés volver a girar.';
        let hhmm = '';
        try { hhmm = at.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (_) {}
        return 'Tu próximo giro: en ' + _msLeftText(ms) + (hhmm ? ' (a las ' + hhmm + ')' : '') + '.';
    }
    // #197 Caja del premio según la etapa del reclamo.
    function _msLeftText(ms) {
        ms = Math.max(0, Number(ms) || 0);
        const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
        return h > 0 ? (h + ' h ' + m + ' min') : (m + ' min');
    }
    function _prizeBox(sp, claimHours) {
        const won = Number(sp.prizeARS || 0) > 0;
        const isPct = sp.prizeType === 'percent' && Number(sp.prizePct) > 0;
        const prizeHtml = isPct
            ? '<div style="color:#fff;font-size:30px;font-weight:900;margin-bottom:6px;">+' + _esc(sp.prizePct) + '% EXTRA</div><div style="color:#ffd479;font-size:13px;font-weight:800;">en tu PRÓXIMA CARGA</div>'
            : '<div style="color:#fff;font-size:32px;font-weight:900;margin-bottom:6px;">$' + _fmt(sp.prizeARS) + '</div>';
        let box = '';
        if (sp.status === 'claim_pending') {
            // Recalcular lo que falta con el reloj local (msLeft vino del server).
            const left = sp.claimExpiresAt ? (new Date(sp.claimExpiresAt).getTime() - Date.now()) : (sp.msLeft || 0);
            box = '<div id="rouletteResultBox" style="background:linear-gradient(135deg,rgba(255,215,0,0.14),rgba(102,255,102,0.08));border:2px solid #ffd700;border-radius:14px;padding:22px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="font-size:56px;line-height:1;margin-bottom:8px;">' + (isPct ? '🎁' : '🎉') + '</div>'
                + '<div style="color:#ffd700;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">¡GANASTE!</div>'
                + prizeHtml
                + '<div style="color:#ffb84d;font-size:12px;font-weight:800;margin-top:8px;">⏰ Tenés ' + _esc(_msLeftText(left)) + ' para reclamarlo</div>'
                + '<button id="rouletteClaimBtn" onclick="VIP.roulette.claim(\'' + _esc(sp.id || '') + '\')" style="margin-top:12px;width:100%;background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;padding:14px;border-radius:12px;font-weight:900;font-size:16px;cursor:pointer;letter-spacing:1px;box-shadow:0 4px 16px rgba(255,215,0,0.45);">🎁 RECLAMAR PREMIO</button>'
                + '<div style="color:#aaa;font-size:10.5px;margin-top:8px;">Si no lo reclamás a tiempo, vence.</div>'
                + '</div>';
        } else if (sp.status === 'expired') {
            box = '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.20);border-radius:14px;padding:22px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="font-size:48px;margin-bottom:6px;">⌛</div>'
                + '<div style="color:#aaa;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">Premio vencido</div>'
                + '<div style="color:#ddd;font-size:13px;line-height:1.45;">Tenías ' + _esc(claimHours) + ' horas para reclamar ' + (isPct ? 'tu +' + _esc(sp.prizePct) + '% EXTRA' : '$' + _fmt(sp.prizeARS)) + ' y el plazo pasó. ¡Vas a tener otra chance en tu próximo giro!</div>'
                + '</div>';
        } else if (isPct) {
            const used = sp.status === 'percent_used';
            box = '<div id="rouletteResultBox" style="background:linear-gradient(135deg,rgba(255,215,0,0.12),rgba(102,255,102,0.08));border:2px solid #ffd700;border-radius:14px;padding:22px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="font-size:56px;line-height:1;margin-bottom:8px;">🎁</div>'
                + '<div style="color:#ffd700;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">' + (used ? 'PREMIO APLICADO' : 'PREMIO RECLAMADO') + '</div>'
                + prizeHtml
                + (used
                    ? '<div style="background:rgba(102,255,102,0.20);border:1px solid #66ff66;border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:12.5px;font-weight:800;">✅ Ya se aplicó en una carga</div>'
                    : '<div style="background:rgba(255,215,0,0.14);border:1px solid rgba(255,215,0,0.6);border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:12.5px;line-height:1.45;">Cuando vayas a cargar, avisale al agente: te suma el <strong>' + _esc(sp.prizePct) + '%</strong> de la carga como bono.</div>')
                + '</div>';
        } else if (won && sp.status === 'claimed') {
            box = '<div id="rouletteResultBox" style="background:linear-gradient(135deg,rgba(102,255,102,0.10),rgba(255,215,0,0.10));border:2px solid #66ff66;border-radius:14px;padding:22px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="font-size:56px;line-height:1;margin-bottom:8px;">🎉</div>'
                + '<div style="color:#66ff66;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">PREMIO RECLAMADO</div>'
                + prizeHtml
                + '<div style="background:rgba(255,215,0,0.14);border:1px solid rgba(255,215,0,0.6);border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:12.5px;line-height:1.45;">⏳ En unos minutos un agente te lo carga en tu usuario de GANAMOS y te avisamos por el chat.</div>'
                + '</div>';
        } else if (won && sp.status === 'credited') {
            box = '<div id="rouletteResultBox" style="background:linear-gradient(135deg,rgba(102,255,102,0.10),rgba(255,215,0,0.10));border:2px solid #66ff66;border-radius:14px;padding:22px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="font-size:56px;line-height:1;margin-bottom:8px;">🎉</div>'
                + '<div style="color:#66ff66;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">¡GANASTE!</div>'
                + prizeHtml
                + '<div style="background:rgba(102,255,102,0.20);border:1px solid #66ff66;border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:13px;font-weight:800;">✅ Cargado en tu usuario de GANAMOS</div>'
                + '</div>';
        } else if (won && sp.status === 'credit_failed') {
            box = '<div style="background:rgba(255,170,102,0.10);border:2px solid #ffaa66;border-radius:14px;padding:20px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="font-size:48px;margin-bottom:6px;">⚠️</div>'
                + '<div style="color:#ffaa66;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">PREMIO PENDIENTE</div>'
                + prizeHtml
                + '<div style="color:#ffd0a0;font-size:12px;margin-top:8px;">Hubo un problema al cargarlo. Escribinos por el chat y lo resolvemos.</div>'
                + '</div>';
        } else if (won) {
            // legacy 'won' (acreditación en curso sin reclamo)
            box = '<div style="background:rgba(255,170,102,0.10);border:2px solid #ffaa66;border-radius:14px;padding:20px 16px;text-align:center;margin-bottom:12px;">'
                + '<div style="color:#ffaa66;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">PROCESANDO</div>' + prizeHtml + '</div>';
        }
        return box;
    }

    // #197 Reclamar el premio (dentro del plazo).
    let _claiming = false;
    async function claim(spinId) {
        if (_claiming) return;
        _claiming = true;
        const btn = document.getElementById('rouletteClaimBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Reclamando…'; }
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/roulette/claim`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ spinId: spinId || undefined })
            });
            const d = await resp.json();
            if (d && d.spin) {
                if (_state.spin && _state.spin.id === d.spin.id) _state.spin = d.spin;
                if (_state.openPrize && _state.openPrize.id === d.spin.id) _state.openPrize = d.spin;
                if (!_state.spin || (_state.spin.id !== d.spin.id && (!_state.openPrize || _state.openPrize.id !== d.spin.id))) _state.openPrize = d.spin;
            }
            if (!resp.ok || !d.success) {
                if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast((d && d.error) || 'No se pudo reclamar', d && d.expired ? 'info' : 'error');
            } else if (VIP.ui && VIP.ui.showToast) {
                VIP.ui.showToast('✅ ¡Premio reclamado!', 'success');
            }
            await loadStatus();
            _renderModal();
        } catch (e) {
            if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast('Error de conexión', 'error');
        } finally {
            _claiming = false;
        }
    }

    function _renderModal(spinResult) {
        const modal = document.getElementById('rouletteModal');
        if (!modal) return;
        if (!_state) {
            modal.innerHTML = '<div style="background:#1a0033;border:2px solid #d4af37;border-radius:14px;padding:30px;color:#fff;text-align:center;max-width:560px;width:100%;margin:14px auto;">⏳ Cargando…</div>';
            return;
        }
        const spin = spinResult || _state.spin;
        const alreadySpun = !!(spin && (spin.prizeARS != null || spin.prizeType));
        const claimHours = _state.claimHours || 24;
        const openPrize = _state.openPrize; // #197 premio de otro día aún abierto (por reclamar / en carga / % pendiente)
        let html = '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:2px solid #ffd700;border-radius:16px;padding:20px 16px;color:#fff;max-width:560px;width:100%;margin:14px auto;position:relative;">';
        html += '<button onclick="VIP.roulette.close()" style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.20);color:#fff;font-size:18px;cursor:pointer;line-height:1;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;">✕</button>';
        html += '<h2 style="color:#ffd700;text-align:center;margin:0 0 4px;font-size:22px;font-weight:900;letter-spacing:1.5px;padding-right:36px;display:flex;align-items:center;justify-content:center;gap:8px;">' + _miniWheel(26) + '<span>RULETA DIARIA</span></h2>';
        const spd = Number(_state.spinsPerDay) || 1; // #200 giros por día
        const spinsLeft = _state.spinsLeft != null ? Number(_state.spinsLeft) : (alreadySpun ? 0 : spd);
        html += '<p style="color:#ddd;text-align:center;margin:0 0 14px;font-size:12px;line-height:1.4;">' + (spd > 1 ? spd + ' giros cada 24 h' : '1 giro cada 24 h') + ' · si ganás, tenés ' + _esc(claimHours) + ' h para reclamar tu premio</p>';

        // #201 La RUEDA (SVG). Sin girar: en reposo; ya girada: clavada en el premio que salió.
        html += _WHEEL_CSS;
        let winIdx = -1;
        if (alreadySpun && spin) {
            winIdx = _segIndexFor(spin);
            if (_wheelAngle == null) _wheelAngle = _angleForSeg(winIdx, 0);
        }
        // #202 en reposo (sin girar) el puntero queda CENTRADO sobre el primer gajo, no en un borde.
        if (_wheelAngle == null) _wheelAngle = _angleForSeg(0, 0);
        html += _wheelSvg(_wheelAngle || 0, alreadySpun ? winIdx : -1);

        // #197 Premio de OTRO día que sigue abierto (por reclamar / en carga / % pendiente):
        // se muestra arriba del giro de hoy para que no se lo pierda.
        if (openPrize && (!alreadySpun || (spin && openPrize.id !== spin.id))) html += _prizeBox(openPrize, claimHours);

        // #200 con varios giros por día: si ya giró pero le quedan giros, muestra el último
        // resultado (si ganó) y abajo el botón para volver a girar.
        if (alreadySpun && spinsLeft > 0) {
            const wonL = Number(spin.prizeARS || 0) > 0 || (spin.prizeType === 'percent' && Number(spin.prizePct) > 0);
            if (wonL) html += _prizeBox(spin, claimHours);
        }
        if (alreadySpun && spinsLeft <= 0) {
            // Estado: ya usó todos sus giros de hoy.
            const won = Number(spin.prizeARS || 0) > 0;
            const isPct = spin.prizeType === 'percent' && Number(spin.prizePct) > 0;
            if (won || isPct) {
                html += _prizeBox(spin, claimHours);
                if (spin.status === 'credited' || spin.status === 'claimed') html += _communityRecommendCard();
            } else {
                html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.20);border-radius:14px;padding:24px 16px;text-align:center;margin-bottom:12px;">';
                // #202 sin emojis: ícono dorado (trébol) dibujado en SVG.
                html += '<div style="margin:0 auto 10px;width:58px;height:58px;">' + _cloverSvg() + '</div>';
                html += '<div style="color:#ffd700;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">Hoy no fue tu día</div>';
                html += '<div style="color:#ddd;font-size:13.5px;line-height:1.45;">' + _nextSpinText() + ' ¡La suerte cambia!</div>';
                html += '</div>';
            }
            html += '<div style="text-align:center;color:#aaa;font-size:11.5px;margin:-4px 0 10px;">⏱ ' + _nextSpinText() + '</div>';
            html += '<button onclick="VIP.roulette.close()" style="width:100%;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.20);padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer;">CERRAR</button>';
        } else {
            // Estado: aún no giró. Ícono 🎰 con animación + CTA. Sin tabla
            // de probabilidades (el reparto ahora es por monto diario).
            // #201 CTA debajo de la rueda.
            html += '<div id="rouletteResultBox" style="text-align:center;margin-bottom:12px;">';
            html += '<div style="color:#ffd700;font-size:15px;font-weight:900;letter-spacing:1px;margin-bottom:3px;">' + (spd > 1 ? 'Te quedan ' + spinsLeft + ' giro' + (spinsLeft === 1 ? '' : 's') + ' hoy' : 'Tu giro de hoy te espera') + '</div>';
            html += '<div id="rouletteSpinHint" style="color:#ddd;font-size:12px;margin-bottom:12px;opacity:0.92;">Tocá <strong>GIRAR</strong> y la suerte decide. Si ganás, reclamá tu premio dentro de las ' + _esc(claimHours) + ' horas.</div>';
            html += '<button id="rouletteSpinBtn" class="rw-btn" onclick="VIP.roulette.spin()">🎡 GIRAR</button>';
            html += '</div>';
            // #203 (owner): sin fichitas de premios debajo de GIRAR — los premios ya están en la rueda.
        }

        // Bloque de transparencia: ganadores del día (live), DENTRO del modal.
        // Cuando el user gana, esto le da contexto + social proof. Cuando
        // pierde, refuerza que la ruleta sí paga. Reusa el mismo cache que
        // el card del home y se sincroniza con auto-refresh.
        html += '<div style="margin-top:14px;background:rgba(0,0,0,0.50);border:1px solid rgba(255,215,0,0.30);border-radius:11px;padding:11px 12px;">';
        html += '  <div style="text-align:center;background:linear-gradient(135deg,rgba(37,211,102,0.18),rgba(255,215,0,0.12));border:1px solid rgba(37,211,102,0.45);border-radius:9px;padding:7px 10px;margin:0 0 9px;">';
        html += '    <div style="color:#25d366;font-weight:900;font-size:10.5px;letter-spacing:1.4px;line-height:1.25;">✨ TRANSPARENCIA ABSOLUTA</div>';
        html += '    <div style="color:#ffd700;font-weight:800;font-size:11.5px;letter-spacing:0.4px;line-height:1.25;">TODO PARA USTEDES</div>';
        html += '  </div>';
        html += '  <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">';
        html += '    <span style="font-size:14px;">🏆</span>';
        html += '    <span style="color:#ffd700;font-weight:900;font-size:11px;letter-spacing:1px;">GANADORES DE HOY · EN VIVO</span>';
        html += '    <span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#25d366;font-weight:700;">';
        html += '      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#25d366;box-shadow:0 0 5px #25d366;animation:winners-pulse 1.4s ease-in-out infinite;"></span>';
        html += '      LIVE';
        html += '    </span>';
        html += '  </div>';
        html += '  <div id="rouletteModalWinnersList" style="max-height:240px;overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:12px;line-height:1.5;"></div>';
        html += '  <div id="rouletteModalWinnersEmpty" style="text-align:center;color:#888;font-size:11.5px;padding:12px 8px;">Todavía no hay ganadores hoy. Sé el primero — girá la ruleta.</div>';
        html += '  <div style="text-align:center;font-size:10px;color:#777;margin-top:7px;padding-top:7px;border-top:1px dashed rgba(255,255,255,0.10);">🔒 Nombres parcialmente ocultos. Los premios son reales.</div>';
        html += '</div>';

        html += '</div>';
        modal.innerHTML = html;

        // Pintar lista con el cache que tengamos y refrescar del server.
        _renderWinnersListInto(
            document.getElementById('rouletteModalWinnersList'),
            document.getElementById('rouletteModalWinnersEmpty'),
            _recentWinnersCache
        );
        loadRecentWinners();
    }

    // #201 Ángulo actual del rotor leyendo la matriz CSS (sirve mientras corre la animación idle).
    function _currentRotorAngle(rotor) {
        try {
            const t = getComputedStyle(rotor).transform;
            if (!t || t === 'none') return _wheelAngle || 0;
            const m = t.match(/matrix\(([^)]+)\)/);
            if (!m) return _wheelAngle || 0;
            const v = m[1].split(',').map(Number);
            let deg = Math.atan2(v[1], v[0]) * 180 / Math.PI;
            if (deg < 0) deg += 360;
            return deg;
        } catch (_) { return _wheelAngle || 0; }
    }
    // Arranca el giro libre (mientras el server decide).
    function _wheelStart() {
        const rotor = document.getElementById('rouletteRotor');
        const wrap = document.getElementById('rouletteWheelWrap');
        if (!rotor) return;
        rotor.style.transition = 'none';
        rotor.style.transform = 'rotate(' + (_wheelAngle || 0) + 'deg)';
        // eslint-disable-next-line no-unused-expressions
        rotor.getBoundingClientRect();
        rotor.classList.add('idle');
        if (wrap) wrap.classList.add('spinning');
    }
    // Frena la rueda hasta el gajo `idx`. Resuelve cuando se detuvo.
    function _wheelStopAt(idx) {
        return new Promise((resolve) => {
            const rotor = document.getElementById('rouletteRotor');
            const wrap = document.getElementById('rouletteWheelWrap');
            if (!rotor) { _wheelAngle = _angleForSeg(idx, 0); return resolve(); }
            const n = _wheelSegments().length;
            const half = 180 / n;
            const jitter = (Math.random() * 2 - 1) * half * 0.55; // cae dentro del gajo, no siempre en el centro
            const target = _angleForSeg(idx, jitter);
            const current = _currentRotorAngle(rotor);
            rotor.classList.remove('idle');
            rotor.style.transition = 'none';
            rotor.style.transform = 'rotate(' + current + 'deg)';
            rotor.getBoundingClientRect();
            const delta = ((target - (current % 360)) + 360) % 360;
            const finalAngle = current + 5 * 360 + delta;
            let done = false;
            const finish = () => {
                if (done) return; done = true;
                _wheelAngle = ((finalAngle % 360) + 360) % 360;
                if (wrap) wrap.classList.remove('spinning');
                try { rotor.querySelectorAll('.rw-seg').forEach((el, i) => el.classList.toggle('win', i === idx)); } catch (_) {}
                resolve();
            };
            rotor.addEventListener('transitionend', finish, { once: true });
            setTimeout(finish, 5600);
            requestAnimationFrame(() => {
                rotor.style.transition = 'transform 5s cubic-bezier(.12,.75,.08,1)';
                rotor.style.transform = 'rotate(' + finalAngle + 'deg)';
            });
        });
    }

    async function spin() {
        if (_spinning) return;
        _spinning = true;
        // #201 la rueda arranca a girar mientras el server decide el premio.
        const box = document.getElementById('rouletteResultBox');
        const btn = document.getElementById('rouletteSpinBtn');
        const hint = document.getElementById('rouletteSpinHint');
        if (btn) { btn.disabled = true; btn.textContent = '🎡 GIRANDO…'; }
        if (hint) hint.textContent = '¡Suerte!';
        _wheelStart();
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/roulette/spin`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' }
            });
            const d = await resp.json();
            if (!resp.ok) {
                // Rebote: la rueda para donde estaba.
                const rotor0 = document.getElementById('rouletteRotor');
                if (rotor0) { rotor0.classList.remove('idle'); rotor0.style.transform = 'rotate(' + (_wheelAngle || 0) + 'deg)'; }
                const wrap0 = document.getElementById('rouletteWheelWrap');
                if (wrap0) wrap0.classList.remove('spinning');
                if (btn) { btn.disabled = false; btn.textContent = '🎡 GIRAR'; }
                if (d && d.alreadySpun) {
                    _state.alreadySpun = true;
                    _state.spinsLeft = 0;
                    _state.nextSpinAt = d.nextSpinAt || _state.nextSpinAt || null; // #208
                    _state.spin = d.spin;
                    _wheelAngle = null;
                    _renderModal();
                } else if (d && d.needsAppNotifs) {
                    // No tiene app instalada y/o notifs aceptadas — mostrar
                    // el modal con los pasos clarito para que pueda participar.
                    _showNeedsAppModal();
                } else {
                    if (box) box.innerHTML = '<div style="color:#ff8080;padding:20px;">❌ ' + _esc((d && d.error) || 'Error') + '</div>';
                }
                _spinning = false;
                return;
            }
            // #201 Frenar la rueda en el gajo del premio y recién ahí mostrar el resultado.
            const idx = _segIndexFor(d.prize);
            await _wheelStopAt(idx);
            await new Promise(r => setTimeout(r, 650));
            _state.spinsLeft = d.spinsLeft != null ? Number(d.spinsLeft) : 0; // #200
            _state.nextSpinAt = d.nextSpinAt || null; // #208
            _state.alreadySpun = true;
            _state.spin = d.prize; // #197 forma pública del spin (id, status, claimExpiresAt…)
            if (d.prize && d.prize.claimHours) _state.claimHours = d.prize.claimHours;
            _renderModal();
            renderHomeCard();
            // Refrescar saldo del header (mismo patrón que installbonus/withdraw).
            // FIX 2026-07-09: antes llamaba a VIP.auth.refreshBalance, que nunca
            // existió → el saldo no se refrescaba tras ganar. Lo real es ui.syncBalance.
            try { if (window.VIP && VIP.ui && typeof VIP.ui.syncBalance === 'function') VIP.ui.syncBalance(); } catch (_) {}
        } catch (e) {
            const rotorE = document.getElementById('rouletteRotor');
            if (rotorE) { rotorE.classList.remove('idle'); rotorE.style.transform = 'rotate(' + (_wheelAngle || 0) + 'deg)'; }
            if (box) box.innerHTML = '<div style="color:#ff8080;padding:20px;">Error de conexión. Probá de nuevo.</div>';
        } finally {
            _spinning = false;
        }
    }

    // Cache para reusar la lista en el modal sin re-fetch.
    let _recentWinnersCache = [];

    function _renderWinnersListInto(listEl, emptyEl, winners) {
        if (!listEl) return;
        if (!winners || winners.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        let html = '';
        for (const w of winners) {
            // Horario hh:mm en hora local del browser (ART para la mayoría).
            let hhmm = '';
            try {
                const d = new Date(w.spunAt);
                hhmm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
            } catch (_) { hhmm = ''; }
            html += '<div class="winner-row' + (w.isMe ? ' is-me' : '') + '">';
            html += '<span class="winner-user">👤 ' + _esc(w.username) + '</span>';
            html += '<span class="winner-prize">' + (w.prizeType === 'percent' ? ('+' + _esc(w.prizePct) + '% próx. carga') : ('+$' + _fmt(w.prizeARS))) + '</span>';
            html += '<span class="winner-time">' + hhmm + '</span>';
            html += '</div>';
        }
        listEl.innerHTML = html;
    }

    // Lista de ganadores del día (transparencia). 🪦 El recuadro del HOME
    // (rouletteWinnersList) fue ELIMINADO 2026-08-05 (owner: confundía en el
    // inicio) — ahora los ganadores se pintan SOLO dentro del modal de la
    // ruleta. 80% del nombre tapado server-side.
    async function loadRecentWinners() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/roulette/recent-winners?limit=50`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const d = await r.json();
            const winners = Array.isArray(d.winners) ? d.winners : [];
            _recentWinnersCache = winners;
            // Solo dentro del modal (si está abierto).
            _renderWinnersListInto(
                document.getElementById('rouletteModalWinnersList'),
                document.getElementById('rouletteModalWinnersEmpty'),
                winners
            );
        } catch (e) { /* best-effort */ }
    }

    // #199 Desde el menú ☰: si le falta la app, muestra los pasos; si no, abre la ruleta.
    async function openFromMenu() {
        if (!_state) await loadStatus();
        if (_state && _state.needsAppNotifs) return _showNeedsAppModal();
        if (_state && _state.needsActive && VIP.ui && VIP.ui.showToast) {
            return VIP.ui.showToast('🎰 La ruleta diaria es para clientes activos: necesitás más de ' + _state.minCargas + ' cargas en los últimos ' + (_state.minCargasDays || 30) + ' días (llevás ' + (Number(_state.cargas30d) || 0) + ').', 'info');
        }
        open();
    }
    VIP.roulette = { loadStatus, open, close, spin, claim, openFromMenu, needsApp: _showNeedsAppModal, loadRecentWinners,
        _debugWheelSvg: (prizes, angle, winIdx) => { _state = { prizes }; return _wheelSvg(angle, winIdx); } }; // #201 sólo para render de prueba

    // Boot: cargar status apenas el usuario esté autenticado.
    document.addEventListener('DOMContentLoaded', () => {
        const tryLoad = () => {
            if (VIP.state && VIP.state.currentToken) {
                loadStatus();
                loadRecentWinners();
            } else {
                setTimeout(tryLoad, 1500);
            }
        };
        setTimeout(tryLoad, 800);
    });

    // Refresh al volver visible.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            loadStatus();
            loadRecentWinners();
        }
    });

    // Auto-refresh cada 30s para mostrar nuevos ganadores en vivo. Solo
    // mientras la página es visible, para no quemar batería en background.
    setInterval(() => {
        if (document.visibilityState === 'visible' && VIP.state && VIP.state.currentToken) {
            loadRecentWinners();
        }
    }, 30000);
})();
