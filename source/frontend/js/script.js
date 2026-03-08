const host = window.location.hostname;

const ENDPOINTS = {
    WS: `ws://${host}:8000/ws`,
    API: `http://${host}:8000/api/commands`,
    SIMULATOR: `http://${host}:8000/api/sensors`,
    RULES: `http://${host}:8001/api/rules`
};

const SENSORS_REGISTRY = [
    { id: 'greenhouse_temperature_value', simId: 'greenhouse_temperature', label: 'Greenhouse Temp', shortLabel: 'TEMP.', unit: '°C', min: 0, max: 40 },
    { id: 'entrance_humidity_value', simId: 'entrance_humidity', label: 'Entrance Humidity', shortLabel: 'HUM.', unit: '%', min: 0, max: 100 },
    { id: 'co2_hall_value', simId: 'co2_hall', label: 'CO2 Hall Level', shortLabel: 'CO2', unit: 'ppm', min: 400, max: 1000 },
    { id: 'corridor_pressure_value', simId: 'corridor_pressure', label: 'Corridor Pressure', shortLabel: 'PRE.', unit: 'kPA', min: 90, max: 115 },
    { id: 'water_tank_level_level_pct', simId: 'water_tank_level', label: 'Water Tank Level', shortLabel: 'WATER %', unit: '%', min: 0, max: 100 },
    { id: 'water_tank_level_level_liters', simId: 'water_tank_level', label: 'Water Tank Vol', shortLabel: 'WATER L', unit: 'L', min: 0, max: 3000 },
    { id: 'hydroponic_ph_ph', simId: 'hydroponic_ph', label: 'Hydroponic pH', shortLabel: 'HYDRO', unit: 'pH', min: 4.0, max: 9.0 },
    { id: 'air_quality_pm25_pm25_ug_m3', simId: 'air_quality_pm25', label: 'PM 2.5 Level', shortLabel: 'PM 2.5', unit: 'µg', min: 0, max: 50 },
    { id: 'air_quality_pm25_pm1_ug_m3', simId: 'air_quality_pm25', label: 'PM 1.0 Level', shortLabel: 'PM 1.0', unit: 'µg', min: 0, max: 30 },
    { id: 'air_quality_pm25_pm10_ug_m3', simId: 'air_quality_pm25', label: 'PM 10 Level', shortLabel: 'PM 10', unit: 'µg', min: 0, max: 60 },
    { id: 'air_quality_voc_voc_ppb', simId: 'air_quality_voc', label: 'Volatile Org. Comp', shortLabel: 'VOC', unit: 'ppb', min: 0, max: 600 },
    { id: 'air_quality_voc_co2e_ppm', simId: 'air_quality_voc', label: 'CO2 Equivalent', shortLabel: 'CO2e', unit: 'ppm', min: 400, max: 1500 }
];

const ACTUATOR_IDS = ['cooling_fan', 'habitat_heater', 'hall_ventilation', 'entrance_humidifier'];

let systemState = { booted: false, sensorsReceived: new Set(), actuators: {}, criticalSensors: new Set() };
let currentRulesList = []; 
let editingRuleId = null;

// --- SAFETY OFFICER STATE ---
let auditLogs = []; // Parte vuoto, si riempie dinamicamente
let ingestionTimestamps = {}; 
let ingestionCounts = {}; // Conta i pacchetti ricevuti per la tabella
let lastOperationTime = "N/A";
let lastManualCommandTime = 0;

// --- UTILS ---

function addLog(msg, color) { 
    const log = document.getElementById('log-console'); 
    if(log) log.innerHTML = `<div><span style="color:#555">[${new Date().toLocaleTimeString()}]</span> <span style="color:${color}">${msg}</span></div>` + log.innerHTML; 
}

function matchSensorId(fullId, partialName) {
    if (!partialName || typeof partialName !== 'string') return false;
    const normalize = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = normalize(fullId);
    const b = normalize(partialName);
    return a.includes(b) || b.includes(a);
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    if(type === 'error') toast.style.borderLeftColor = '#ef4444';
    if(type === 'info') toast.style.borderLeftColor = '#3b82f6';
    
    toast.innerHTML = `
        <div style="color: #555; font-size: 10px; margin-bottom: 4px;">SYSTEM NOTIFICATION</div>
        <div>${message}</div>
    `;
    
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = '0.5s';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

function openModal(message, onConfirm) {
    const overlay = document.getElementById('custom-modal-overlay');
    const msgEl = document.getElementById('modal-message');
    if (!overlay || !msgEl) return;

    msgEl.innerText = message;
    overlay.style.display = 'flex';
    
    const confirmBtn = document.getElementById('btn-confirm-action');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    newConfirmBtn.addEventListener('click', () => {
        onConfirm();
        closeModal();
    });
}

function closeModal() {
    const overlay = document.getElementById('custom-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

// --- INIT ---
function initMissionControl() {
    document.body.classList.add('no-scroll');
    renderGrid();
    renderEngineerViews();
    renderSafetyView();
    addLog("System Boot Sequence Initiated...", "#f59e0b");
    connect();
    
    // Timer per aggiornare "Xs ago" in Safety View
    setInterval(updateIngestionTimers, 1000);
}

function renderGrid() {
    const grid = document.getElementById('sensor-grid');
    if (!grid) return;
    grid.innerHTML = SENSORS_REGISTRY.map(s => `
        <div class="sensor-card" id="card-${s.id}" onclick="toggleCardView('${s.id}')">
            <div class="view-primary">
                <span class="status-label status-ok" id="status-${s.id}">● NORMAL</span>
                <div class="sensor-value-group"><h2 id="val-${s.id}">--.-</h2><span class="unit">${s.unit}</span></div>
                <p class="sensor-label">${s.label}</p>
            </div>
            <div class="view-secondary">
                <span class="status-label" style="color:#aaa;">MONITORING RANGE</span>
                <div class="sensor-value-group"><h2 id="val-sec-${s.id}">--.-</h2><span class="unit">${s.unit}</span></div>
                <div class="mini-progress-container"><div class="mini-progress-bar" id="bar-${s.id}" style="width: 0%;"></div></div>
                <div style="display:flex; justify-content:space-between; width:100%;">
                    <p class="sensor-label">MIN: ${s.min}</p><p class="sensor-label">MAX: ${s.max}</p>
                </div>
                <div class="refresh-section">
                    <span class="auto-refresh-label">● AUTO-REFRESH (5s)</span>
                    <button class="refresh-btn" onclick="forceRefresh('${s.id}', event)">↻ FETCH</button>
                </div>
            </div>
        </div>
    `).join('');
}

// --- AUTOMATION ENGINEER VIEW ---
function renderEngineerViews() {
    const miniGrid = document.getElementById('mini-sensor-grid');
    if (miniGrid) {
        miniGrid.innerHTML = SENSORS_REGISTRY.map(s => `
            <div class="mini-card">
                <span class="mini-card-label">${s.shortLabel}</span>
                <span class="mini-card-val" id="mini-val-${s.id}">--.- <span style="font-size:9px;color:#555">${s.unit}</span></span>
            </div>
        `).join('');
    }

    const sensorSelect = document.getElementById('rule-sensor');
    if (sensorSelect) {
        sensorSelect.innerHTML = SENSORS_REGISTRY.map(s => `<option value="${s.simId}">${s.label}</option>`).join('');
        const updateInputLimits = () => {
            const sel = SENSORS_REGISTRY.find(x => x.simId === sensorSelect.value);
            if (sel) {
                const unitEl = document.getElementById('rule-unit');
                const valInput = document.getElementById('rule-value');
                if (unitEl) unitEl.innerText = sel.unit;
                if (valInput) {
                    valInput.min = sel.min;
                    valInput.max = sel.max;
                    valInput.placeholder = `${sel.min} - ${sel.max}`;
                }
            }
        };
        sensorSelect.onchange = updateInputLimits;
        updateInputLimits(); 
    }

    const actuatorSelect = document.getElementById('rule-actuator');
    if (actuatorSelect) {
        actuatorSelect.innerHTML = ACTUATOR_IDS.map(a => `<option value="${a}">${a.toUpperCase()}</option>`).join('');
    }
}

// --- SAFETY OFFICER VIEW ---

function renderSafetyView() {
    renderIngestionTable();
    renderAuditTable();
    updateSystemHealth();
}

function renderIngestionTable() {
    const tbody = document.getElementById('ingestion-tbody');
    if (!tbody) return;

    // Raggruppa per simId unico per evitare duplicati nella tabella Ingestion
    const uniqueSensors = [];
    const seenSimIds = new Set();
    
    SENSORS_REGISTRY.forEach(s => {
        if(!seenSimIds.has(s.simId)){
            uniqueSensors.push(s);
            seenSimIds.add(s.simId);
        }
    });

    tbody.innerHTML = uniqueSensors.map(sensor => {
        const simId = sensor.simId;
        const lastTime = ingestionTimestamps[simId];
        const packetCount = ingestionCounts[simId] || 0;
        
        let statusHtml;
        let rowClass = "";
        let latency = 0;

        if (lastTime) {
            latency = Math.floor((Date.now() - lastTime) / 1000);
            if (latency < 5) {
                statusHtml = `<span class="status-green">● LIVE (${latency}s)</span>`;
            } else if (latency < 20) {
                statusHtml = `<span class="status-warn">● STALE (${latency}s)</span>`;
            } else {
                statusHtml = `<span class="status-red">● NO SIGNAL</span>`;
            }
        } else {
            statusHtml = `<span style="color:#666">● WAITING...</span>`;
        }

        // US 9: HULL BREACH CHECK PRIORITY
        if (simId === 'corridor_pressure' && systemState.criticalSensors.has('corridor_pressure_value')) {
            rowClass = "row-critical-flash";
            statusHtml = `<span class="status-red">CRITICAL ALERT</span>`;
        }

        // Schema e Format basati su dati reali (/api/state)
        const rawSchema = "rest_polling"; // Protocollo
        const normFormat = "JSON/Telemetry"; // Formato Payload
        const packetInfo = packetCount > 0 ? `<span style="color:#555; font-size:9px">[${packetCount} pkts]</span>` : "";

        return `
            <tr class="${rowClass}">
                <td style="color:#fff;">${simId}</td>
                <td style="font-family:'Courier New'; font-size:10px; color:#aaa;">${rawSchema}</td>
                <td style="font-family:'Courier New'; font-size:10px;">${normFormat} ${packetInfo}</td>
                <td id="ingest-cell-${simId}">${statusHtml}</td>
            </tr>
        `;
    }).join('');
}

function updateIngestionTimers() {
    if (document.getElementById('safety-view').style.display === 'none') return;

    const seenSimIds = new Set();
    SENSORS_REGISTRY.forEach(s => {
        if(seenSimIds.has(s.simId)) return;
        seenSimIds.add(s.simId);
        
        const simId = s.simId;
        const cell = document.getElementById(`ingest-cell-${simId}`);
        if (!cell) return;

        if (simId === 'corridor_pressure' && systemState.criticalSensors.has('corridor_pressure_value')) {
            cell.innerHTML = `<span class="status-red">CRITICAL ALERT</span>`;
            return;
        }

        const lastTime = ingestionTimestamps[simId];
        if (lastTime) {
            const latency = Math.floor((Date.now() - lastTime) / 1000);
            if (latency < 5) {
                cell.innerHTML = `<span class="status-green">● LIVE (${latency}s)</span>`;
            } else if (latency < 20) {
                cell.innerHTML = `<span class="status-warn">● STALE (${latency}s)</span>`;
            } else {
                cell.innerHTML = `<span class="status-red">● NO SIGNAL</span>`;
            }
        }
    });
}

// US 10: HISTORICAL AUDIT TRAIL
function addToAuditLog(type, actuator, action, reason) {
    const newLog = {
        timestamp: new Date().toLocaleString(),
        type: type, // "MANUAL" o "AUTO"
        actuator: actuator.toUpperCase(),
        action: action,
        reason: reason
    };
    
    lastOperationTime = newLog.timestamp;
    
    // Aggiungi in cima
    auditLogs.unshift(newLog);
    if (auditLogs.length > 10) auditLogs.pop(); // Mantieni max 10 righe
    
    renderAuditTable();
    updateSystemHealth();
}

function renderAuditTable() {
    const tbody = document.getElementById('audit-tbody');
    if (!tbody) return;

    if (auditLogs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#555;">No recent automation or manual override events.</td></tr>`;
        return;
    }

    tbody.innerHTML = auditLogs.map(log => `
        <tr>
            <td style="color:#888; font-size:10px;">${log.timestamp}</td>
            <td><span class="badge ${log.type === 'MANUAL' ? 'badge-blue' : 'badge-orange'}">${log.type}</span></td>
            <td style="font-weight:bold; color:#fff;">${log.actuator}</td>
            <td><span style="color:${log.action.includes('ON') ? '#22c55e' : '#ef4444'}; font-weight:bold;">${log.action}</span></td>
            <td style="font-size:10px;">${log.reason}</td>
        </tr>
    `).join('');
}

function updateSystemHealth() {
    // Totale Allarmi = Numero sensori fuori soglia
    const alertCount = systemState.criticalSensors.size;
    const alertEl = document.getElementById('active-alerts-count');
    const opEl = document.getElementById('last-backup-time');

    if (alertEl) {
        alertEl.innerText = alertCount;
        alertEl.style.color = alertCount > 0 ? '#ef4444' : '#22c55e';
    }
    
    if (opEl) {
        opEl.innerText = lastOperationTime;
    }
}

// --- RULES MANAGEMENT ---
async function saveRule() {
    const sensorSimId = document.getElementById('rule-sensor').value;
    const operator = document.getElementById('rule-operator').value;
    const thresholdVal = document.getElementById('rule-value').value;
    const actuator = document.getElementById('rule-actuator').value;
    const action = document.getElementById('rule-action').value;
    const threshold = parseFloat(thresholdVal);
    
    if (isNaN(threshold)) { showToast("INPUT ERROR", "error"); return; }

    const config = SENSORS_REGISTRY.find(s => s.simId === sensorSimId);
    if (config && (threshold < config.min || threshold > config.max)) {
        showToast("INVALID RANGE", "error");
        return;
    }
    
    const rule = { sensor_id: sensorSimId, operator: operator, threshold: threshold, actuator_id: actuator, action: action };
    
    try {
        if (editingRuleId) await fetch(`${ENDPOINTS.RULES}/${editingRuleId}`, { method: 'DELETE' });
        await fetch(ENDPOINTS.RULES, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(rule) });
        
        fetchRules();
        showToast("RULE SAVED", "success");
        resetEditMode();
        
        lastOperationTime = new Date().toLocaleString();
        updateSystemHealth();
        
    } catch (e) { showToast("SAVE FAILED", "error"); }
}

function editRule(ruleId) {
    const rule = currentRulesList.find(r => r.rule_id == ruleId);
    if (!rule) return;
    editingRuleId = ruleId;
    document.getElementById('rule-sensor').value = rule.sensor_id;
    document.getElementById('rule-sensor').onchange();
    document.getElementById('rule-operator').value = rule.operator;
    document.getElementById('rule-value').value = rule.threshold;
    document.getElementById('rule-actuator').value = rule.actuator_id;
    document.getElementById('rule-action').value = rule.action;
    document.querySelector('.btn-save').innerText = "↻ UPDATE RULE";
    document.querySelector('.rule-creation-card').scrollIntoView({ behavior: 'smooth' });
}

function resetEditMode() {
    editingRuleId = null;
    document.querySelector('.btn-save').innerText = "+ SAVE TO DB";
    document.getElementById('rule-value').value = "";
}

async function fetchRules() {
    try { 
        const res = await fetch(ENDPOINTS.RULES); 
        currentRulesList = await res.json(); 
        renderRules(currentRulesList); 
    } catch (e) {
        document.getElementById('rules-tbody').innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444; padding:20px;">Database Offline.</td></tr>`; 
    }
}

function renderRules(rules) {
    const tbody = document.getElementById('rules-tbody'); 
    if (!tbody) return;

    // FIX DB Rules: Messaggio se vuoto
    if (rules.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#888; padding:20px;">No automation rules active.</td></tr>`;
        return;
    }

    tbody.innerHTML = rules.map(r => `
        <tr>
            <td style="color:#f59e0b;">${r.rule_id}</td>
            <td>IF <strong>${r.sensor_id}</strong> ${r.operator} ${r.threshold}</td>
            <td>SET <strong>${r.actuator_id}</strong> to <span>${r.action}</span></td>
            <td>
                <button class="btn-edit" onclick="editRule('${r.rule_id}')">EDIT</button>
                <button class="btn-del" onclick="askDeleteRule('${r.rule_id}')">DEL</button>
            </td>
        </tr>
    `).join('');
}

function askDeleteRule(id) {
    openModal(`Delete Rule ${id}?`, async () => {
        await fetch(`${ENDPOINTS.RULES}/${id}`, { method: 'DELETE' }); 
        fetchRules(); 
        showToast("Rule Deleted", "info");
        lastOperationTime = new Date().toLocaleString();
        updateSystemHealth();
    });
}

// --- NETWORKING ---
function connect() {
    const socket = new WebSocket(ENDPOINTS.WS);
    socket.onopen = () => { 
        document.getElementById('conn-status').innerText = "ONLINE"; 
        document.getElementById('conn-status').style.color = "#22c55e"; 
        addLog("Data Uplink Established.", "#22c55e");
    };
    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === "FULL_STATE") {
                Object.values(msg.data).forEach(entry => processEventData(entry));
                checkBootSequence();
            } else if (msg.type === "LIVE_UPDATE") {
                processEventData(msg.data);
                checkBootSequence();
            }
        } catch(e) {}
    };
    socket.onclose = () => setTimeout(connect, 3000);
}

function processEventData(entry) {
    if (!entry || !entry.source) return;
    const id = entry.source.identifier;
    
    appendRawLog(entry);
    
    ingestionTimestamps[id] = Date.now();
    ingestionCounts[id] = (ingestionCounts[id] || 0) + 1; // Incrementa contatore pacchetti

    if (ACTUATOR_IDS.includes(id)) {
        syncActuator(id, entry.payload.value);
    } else {
        let valueFound = false;
        if (entry.payload && entry.payload.measurements) {
        entry.payload.measurements.forEach(m => {
            const mName = m.name || m.metric;
            // Cerca il sensore usando matchSensorId per ignorare punti e underscore
            const config = SENSORS_REGISTRY.find(s => matchSensorId(s.id, mName));
            if (config) {
                updateSensor(config.id, m.value);
                ingestionTimestamps[config.simId] = Date.now(); // Aggiorna la tabella Safety
            }
        });
}
        
        if (!valueFound) {
            const regEntry = SENSORS_REGISTRY.find(s => s.simId === id);
            const value = entry.payload ? entry.payload.value : entry.value;
            const targetId = regEntry ? regEntry.id : id;
            
            let finalValue = value;
            if (finalValue === undefined && entry.payload) {
                const keys = Object.keys(entry.payload);
                const matchKey = keys.find(k => matchSensorId(targetId, k));
                if (matchKey) finalValue = entry.payload[matchKey];
            }

            if (finalValue !== undefined) {
                updateSensor(targetId, finalValue, id);
            }
        }
    }
    
    // Ridisegna tabelle Safety se visibile
    if (document.getElementById('safety-view').style.display !== 'none') {
        renderIngestionTable();
        updateSystemHealth();
    }
}

function appendRawLog(entry, isCommand = false) {
    const log = document.getElementById('raw-log-console');
    if (!log) return;
    const time = new Date().toLocaleTimeString();
    const row = document.createElement('div');
    row.className = "raw-log-entry";
    const prefix = isCommand ? '<span style="color:#f59e0b;">> CMD:</span>' : '<span style="color:#22c55e;">> DATA:</span>';
    row.innerHTML = `${prefix} <span style="color:#555">[${time}]</span> <pre>${JSON.stringify(entry, null, 2)}</pre>`;
    log.prepend(row);
    if (log.children.length > 50) log.removeChild(log.lastChild);
}

function updateSensor(id, val, simId) {
    const config = SENSORS_REGISTRY.find(s => s.id === id);
    if (!config) return;
    
    systemState.sensorsReceived.add(id);

    // FIX ENGINEER VIEW: Aggiorna Mini-Telemetry
    const elMini = document.getElementById(`mini-val-${id}`);
    if (elMini) elMini.innerHTML = `${typeof val === 'number' ? val.toFixed(1) : val} <span style="font-size:9px;color:#555">${config.unit}</span>`;

    // Aggiorna Mission Specialist View
    const elPrim = document.getElementById(`val-${id}`);
    if (elPrim) elPrim.innerText = typeof val === 'number' ? val.toFixed(1) : val;
    
    const bar = document.getElementById(`bar-${id}`);
    if (bar && typeof val === 'number') {
        let pct = ((val - config.min) / (config.max - config.min)) * 100;
        bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        bar.style.background = (val < config.min || val > config.max) ? '#ef4444' : '#22c55e';
    }

    const isCrit = (val > config.max || val < config.min);
    const card = document.getElementById(`card-${id}`);

    const elSec = document.getElementById(`val-sec-${id}`);
    if (elSec) elSec.innerText = displayVal; // displayVal è il valore formattato
    
    if (isCrit) {
        if (card) card.classList.add('card-alert');
        systemState.criticalSensors.add(id);
        
        // AUTO AUDIT LOG (Simulazione intervento automatico)
        if (!config.lastAutoLog || (Date.now() - config.lastAutoLog > 15000)) {
            addToAuditLog("AUTO", "FAILSAFE_SYSTEM", "TRIGGERED", `Threshold Exceeded: ${config.label} (${val})`);
            config.lastAutoLog = Date.now();
        }
    } else {
        if (card) card.classList.remove('card-alert');
        systemState.criticalSensors.delete(id);
    }

    // BANNER GLOBALE (HULL BREACH E GENERALE)
    const banner = document.getElementById('critical-banner');
    if (id === 'corridor_pressure_value' && val < 90) {
        banner.style.display = 'block';
        banner.style.background = '#f97316';
        banner.innerText = "⚠️ CRITICAL ALERT: HULL BREACH DETECTED - PRESSURE UNDER SAFE THRESHOLD";
    } else if (systemState.criticalSensors.size > 0) {
        banner.style.display = 'block';
        banner.style.background = '#ef4444';
        banner.innerText = "CRITICAL OVERRIDE: ENVIRONMENTAL PARAMETERS BEYOND SAFETY LIMITS";
    } else {
        banner.style.display = 'none';
    }
    
    updateSystemHealth();
}

function syncActuator(id, rawState) {
    let newState = (String(rawState).toUpperCase() === "ON" || rawState === true) ? "ON" : "OFF";
    const toggle = document.getElementById(`toggle-${id}`);
    if (toggle) { toggle.checked = (newState === "ON"); toggle.disabled = false; }
    const txt = document.getElementById(`status-text-${id}`);
    if (txt) { txt.innerHTML = `STATUS: <span style="color: ${newState==="ON"?"#22c55e":"#555"}">${newState}</span>`; }
}

async function manualToggle(id, isChecked) {
    const toggle = document.getElementById(`toggle-${id}`);
    const newState = isChecked ? "ON" : "OFF";

    lastManualCommandTime = Date.now(); 
    
    addToAuditLog("MANUAL", id, `SET TO ${newState}`, "Operator Override");

    try {
        await fetch(`${ENDPOINTS.API}/${id}`, { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ state: newState }) 
        });
        showToast("COMMAND SENT", "info");
    } catch (e) {
        showToast("LINK FAILURE", "error");
        toggle.checked = !isChecked;
    }
}

async function forceRefresh(id, event) {
    if (event) event.stopPropagation();
    const config = SENSORS_REGISTRY.find(s => s.id === id);
    if (!config) return;

    showToast(`FETCHING: ${config.shortLabel}`, "info");
    try {
        // Usa GET invece di POST e rimuovi /read
        const res = await fetch(`${ENDPOINTS.SIMULATOR}/${config.simId}`);
        if (!res.ok) throw new Error();
        showToast("FETCH COMPLETE", "success");
    } catch (e) {
        showToast("FETCH FAILED", "error");
    }
}

function checkBootSequence() {
    if (systemState.booted) return;
    if (systemState.sensorsReceived.size >= 5) {
        systemState.booted = true;
        setTimeout(() => { 
            document.getElementById('boot-overlay').style.display = 'none'; 
            document.body.classList.remove('no-scroll'); 
            showToast("SYSTEM ONLINE", "success");
            addLog("All Telemetry Modules Synced.", "#22c55e");
        }, 800);
    }
}

function toggleCardView(id) { 
    const card = document.getElementById(`card-${id}`);
    if (card) card.classList.toggle('active-view'); 
}

function setRole(role) {
    document.getElementById('btn-role-specialist').classList.remove('active');
    document.getElementById('btn-role-engineer').classList.remove('active');
    document.getElementById('btn-role-safety').classList.remove('active');
    document.getElementById(`btn-role-${role}`).classList.add('active');
    
    document.getElementById('specialist-view').style.display = role === 'specialist' ? 'block' : 'none';
    document.getElementById('engineer-view').style.display = role === 'engineer' ? 'block' : 'none';
    document.getElementById('safety-view').style.display = role === 'safety' ? 'block' : 'none';
    
    const title = document.getElementById('main-title');
    if (role === 'specialist') title.innerText = "ARESGUARD: MISSION CONTROL";
    else if (role === 'engineer') title.innerText = "ARESGUARD: AUTOMATION ENGINE";
    else if (role === 'safety') title.innerText = "ARESGUARD: SAFETY AUDIT";
    
    if (role === 'engineer') fetchRules();
    if (role === 'safety') renderSafetyView();
}

window.onload = initMissionControl;