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

// --- HELPER MATCHING (Mantenuto per robustezza Mission Specialist) ---
function matchSensorId(fullId, partialName) {
    if (!partialName || typeof partialName !== 'string') return false;
    const normalize = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = normalize(fullId);
    const b = normalize(partialName);
    return a.includes(b) || b.includes(a);
}

// --- UTILS PER POPUP & MODALI ---
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
    addLog("System Boot Sequence Initiated...", "#f59e0b");
    connect();
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

// --- AUTOMATION ENGINE (RIPRISTINATO DAL TUO FILE) ---

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
    const valueInput = document.getElementById('rule-value');
    
    if (sensorSelect) {
        sensorSelect.innerHTML = SENSORS_REGISTRY.map(s => `<option value="${s.simId}">${s.label}</option>`).join('');
        const updateInputLimits = () => {
            const sel = SENSORS_REGISTRY.find(x => x.simId === sensorSelect.value);
            if (sel) {
                document.getElementById('rule-unit').innerText = sel.unit;
                valueInput.min = sel.min;
                valueInput.max = sel.max;
                valueInput.placeholder = `${sel.min} - ${sel.max}`;
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

async function saveRule() {
    const sensorSimId = document.getElementById('rule-sensor').value;
    const operator = document.getElementById('rule-operator').value;
    const thresholdVal = document.getElementById('rule-value').value;
    const actuator = document.getElementById('rule-actuator').value;
    const action = document.getElementById('rule-action').value;
    const threshold = parseFloat(thresholdVal);
    
    if (isNaN(threshold)) { 
        showToast("INPUT ERROR: Please enter a valid number.", "error");
        return; 
    }

    // VALIDAZIONE RANGE (Ripristinata logica stretta)
    const config = SENSORS_REGISTRY.find(s => s.simId === sensorSimId);
    if (config) {
        if (threshold < config.min || threshold > config.max) {
            showToast(`INVALID VALUE: Range ${config.min} - ${config.max}`, "error");
            return;
        }
    }
    
    const rule = { sensor_id: sensorSimId, operator: operator, threshold: threshold, actuator_id: actuator, action: action };
    
    try {
        if (editingRuleId) {
            await fetch(`${ENDPOINTS.RULES}/${editingRuleId}`, { method: 'DELETE' });
        }
        const res = await fetch(ENDPOINTS.RULES, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(rule)
        });
        
        if(!res.ok) throw new Error();
        
        fetchRules();
        const msg = editingRuleId ? "RULE UPDATED" : "RULE CREATED";
        showToast(msg, "success");
        addLog(`Rule Configured: ${sensorSimId} ${operator} ${threshold}`, "#22c55e");
        resetEditMode();
    } catch (e) {
        showToast("CONNECTION ERROR: Failed to save rule.", "error");
    }
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

    const saveBtn = document.querySelector('.btn-save');
    saveBtn.innerText = "↻ UPDATE RULE";
    saveBtn.style.background = "#3b82f6";
    document.querySelector('.rule-creation-card').scrollIntoView({ behavior: 'smooth' });
}

function resetEditMode() {
    editingRuleId = null;
    const saveBtn = document.querySelector('.btn-save');
    saveBtn.innerText = "+ SAVE TO DB";
    saveBtn.style.background = "#22c55e"; 
    document.getElementById('rule-value').value = "";
}

async function fetchRules() {
    try { 
        const res = await fetch(ENDPOINTS.RULES); 
        if(!res.ok) throw new Error(); 
        currentRulesList = await res.json(); 
        renderRules(currentRulesList); 
    } catch (e) { 
        document.getElementById('rules-tbody').innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444; padding:20px;">Database Offline.</td></tr>`; 
    }
}

function renderRules(rules) {
    const tbody = document.getElementById('rules-tbody'); 
    if (!tbody) return;
    if (rules.length === 0) { 
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No automation rules active.</td></tr>`; 
        return; 
    }
    tbody.innerHTML = rules.map(r => `
        <tr>
            <td style="color:#f59e0b;">${r.rule_id}</td>
            <td>IF <strong>${r.sensor_id}</strong> ${r.operator} ${r.threshold}</td>
            <td>SET <strong>${r.actuator_id}</strong> to <span style="color:${r.action === 'ON' ? '#22c55e' : '#555'}; font-weight:bold;">${r.action}</span></td>
            <td>
                <button class="btn-edit" onclick="editRule('${r.rule_id}')">! EDIT</button>
                <button class="btn-del" onclick="askDeleteRule('${r.rule_id}')">\\ DELETE</button>
            </td>
        </tr>
    `).join('');
}

function askDeleteRule(id) {
    openModal(`Permanently delete Rule ${id}?`, async () => {
        try { 
            await fetch(`${ENDPOINTS.RULES}/${id}`, { method: 'DELETE' }); 
            fetchRules(); 
            showToast(`Rule ${id} removed.`, "error");
            addLog(`Rule ${id} removed.`, "#ef4444"); 
            if (editingRuleId == id) resetEditMode();
        } catch (e) { 
            showToast("Failed to delete rule.", "error");
        } 
    });
}

// --- NETWORKING (CORE) ---

function connect() {
    const socket = new WebSocket(ENDPOINTS.WS);
    socket.onopen = () => { 
        const status = document.getElementById('conn-status');
        if (status) { status.innerText = "ONLINE"; status.style.color = "#22c55e"; }
        addLog("Data Uplink Established.", "#22c55e");
    };
    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === "FULL_STATE") {
                Object.values(msg.data).forEach((entry, index) => setTimeout(() => { processEventData(entry); checkBootSequence(); }, index * 50));
            } else if (msg.type === "LIVE_UPDATE") {
                processEventData(msg.data); checkBootSequence();
            }
        } catch(e) {}
    };
    socket.onclose = () => {
        const status = document.getElementById('conn-status');
        if (status) { status.innerText = "OFFLINE"; status.style.color = "#ef4444"; }
        setTimeout(connect, 3000);
    };
}

// --- LOGICA DI INGESTION & VISUALIZZAZIONE ---

function processEventData(entry) {
    if (!entry || !entry.source) return;
    const id = entry.source.identifier;
    
    // LOG AD ALBERO (RIPRISTINATO COME RICHIESTO)
    appendRawLog(entry);

    if (ACTUATOR_IDS.includes(id)) {
        syncActuator(id, entry.payload.value);
    } else {
        // GESTIONE LIVE (Manteniamo la logica robusta del Mission Specialist)
        let valueFound = false;
        if (entry.payload && entry.payload.measurements) {
            const relevantSensors = SENSORS_REGISTRY.filter(s => s.simId === id);
            relevantSensors.forEach(sensor => {
                const match = entry.payload.measurements.find(m => 
                    matchSensorId(sensor.id, m.name) || matchSensorId(sensor.id, m.metric)
                );
                if (match) {
                    updateSensor(sensor.id, match.value);
                    systemState.sensorsReceived.add(sensor.id);
                    valueFound = true;
                }
            });
        }
        
        if (!valueFound) {
            const regEntry = SENSORS_REGISTRY.find(s => s.simId === id);
            const value = entry.payload ? entry.payload.value : entry.value;
            const targetId = regEntry ? regEntry.id : id;
            
            // Tentativo 2: Scansione payload
            let finalValue = value;
            if (finalValue === undefined && entry.payload) {
                const keys = Object.keys(entry.payload);
                const matchKey = keys.find(k => matchSensorId(targetId, k));
                if (matchKey) finalValue = entry.payload[matchKey];
            }

            if (finalValue !== undefined) {
                updateSensor(targetId, finalValue);
                systemState.sensorsReceived.add(targetId);
            }
        }
    }
}

// --- LOG AD ALBERO (RIPRISTINATO) ---
function appendRawLog(entry, isCommand = false) {
    const log = document.getElementById('raw-log-console');
    if (!log) return;
    const time = new Date().toLocaleTimeString();
    
    const row = document.createElement('div');
    row.className = "raw-log-entry";
    const prefix = isCommand ? '<span style="color:#f59e0b;">> CMD:</span>' : '<span style="color:#22c55e;">> DATA:</span>';
    
    // Visualizzazione JSON formattata (Tree View)
    row.innerHTML = `${prefix} <span style="color:#555">[${time}]</span> <pre>${JSON.stringify(entry, null, 2)}</pre>`;
    
    log.prepend(row);
    if (log.children.length > 50) log.removeChild(log.lastChild);
}

function updateSensor(id, val) {
    const config = SENSORS_REGISTRY.find(s => s.id === id);
    if (!config) return;
    const valStr = typeof val === 'number' ? val.toFixed(1) : val;

    const elPrim = document.getElementById(`val-${id}`);
    if (elPrim) elPrim.innerText = valStr;
    const elSec = document.getElementById(`val-sec-${id}`);
    if (elSec) elSec.innerText = valStr;
    const elMini = document.getElementById(`mini-val-${id}`);
    if (elMini) elMini.innerHTML = `${valStr} <span style="font-size:9px;color:#555">${config.unit}</span>`;
    
    const bar = document.getElementById(`bar-${id}`);
    if (bar && typeof val === 'number') {
        let pct = ((val - config.min) / (config.max - config.min)) * 100;
        bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        bar.style.background = (val < config.min || val > config.max) ? '#ef4444' : '#22c55e';
    }
    
    const card = document.getElementById(`card-${id}`);
    const isCrit = (val > config.max || val < config.min);
    if (card) isCrit ? card.classList.add('card-alert') : card.classList.remove('card-alert');
    
    const statusLabel = document.getElementById(`status-${id}`);
    if (statusLabel) {
        statusLabel.innerText = isCrit ? "● CRITICAL" : "● NORMAL";
        statusLabel.className = `status-label ${isCrit ? 'status-crit' : 'status-ok'}`;
    }
    const banner = document.getElementById('critical-banner');
    if (banner) banner.style.display = document.querySelector('.card-alert') ? 'block' : 'none';
}

function syncActuator(id, rawState) {
    let newState = (String(rawState).toUpperCase() === "ON" || rawState === true) ? "ON" : "OFF";
    const toggle = document.getElementById(`toggle-${id}`);
    if (toggle) { toggle.checked = (newState === "ON"); toggle.disabled = false; }
    const txt = document.getElementById(`status-text-${id}`);
    if (txt) { txt.innerHTML = `STATUS: <span style="color: ${newState==="ON"?"#22c55e":"#555"}">${newState}</span>`; }
}

// --- MISSION SPECIALIST ACTIONS (Mantenuto Robusto) ---

async function forceRefresh(id, event) {
    if (event) event.stopPropagation();
    const config = SENSORS_REGISTRY.find(s => s.id === id);
    if (!config) return;

    addLog(`Manual Fetch: ${config.label}...`, "#f59e0b");
    
    try {
        const res = await fetch(`${ENDPOINTS.SIMULATOR}/${config.simId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        let value = null;

        // Logica di Discovery Automatica (Universale)
        const measurements = data.measurements || (data.payload ? data.payload.measurements : null);
        if (measurements && Array.isArray(measurements)) {
            const match = measurements.find(m => matchSensorId(id, m.name) || matchSensorId(id, m.metric));
            if (match) value = match.value;
        }

        if (value === null) {
            if (data.value !== undefined) value = data.value;
            else if (data.payload && data.payload.value !== undefined) value = data.payload.value;
        }

        if (value === null) {
            const rootKeys = Object.keys(data);
            const payloadKeys = data.payload ? Object.keys(data.payload) : [];
            const allKeys = [...rootKeys, ...payloadKeys];
            const matchKey = allKeys.find(k => {
                if (['status', 'sensor_id', 'timestamp', 'captured_at', 'unit', 'payload'].includes(k)) return false;
                return matchSensorId(id, k);
            });
            if (matchKey) value = data[matchKey] !== undefined ? data[matchKey] : (data.payload ? data.payload[matchKey] : null);
        }

        if (value !== null) {
            updateSensor(id, value);
            showToast("FETCH COMPLETE", "success");
        } else {
            console.warn("Unreadable format:", data);
            throw new Error("Data format mismatch");
        }

    } catch (e) {
        showToast(`FETCH ERROR: ${e.message}`, "error");
    }
}

async function manualToggle(id, isChecked) {
    const toggle = document.getElementById(`toggle-${id}`);
    if (toggle) toggle.disabled = true;
    const newState = isChecked ? "ON" : "OFF";
    addLog(`Manual CMD: ${id} -> ${newState}`, "#3b82f6");
    try {
        await fetch(`${ENDPOINTS.API}/${id}`, { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ state: newState }) 
        });
        showToast("COMMAND SENT", "info");
    } catch (e) {
        showToast("LINK FAILURE", "error");
        if (toggle) toggle.checked = !isChecked;
    } finally {
        if (toggle) toggle.disabled = false;
    }
}

function checkBootSequence() {
    if (systemState.booted) return;
    if (systemState.sensorsReceived.size >= 5) {
        systemState.booted = true;
        setTimeout(() => { 
            const overlay = document.getElementById('boot-overlay');
            if (overlay) overlay.style.display = 'none'; 
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

function addLog(msg, color) { 
    const log = document.getElementById('log-console'); 
    if(log) log.innerHTML = `<div><span style="color:#555">[${new Date().toLocaleTimeString()}]</span> <span style="color:${color}">${msg}</span></div>` + log.innerHTML; 
}

function setRole(role) {
    document.getElementById('btn-role-specialist').classList.remove('active');
    document.getElementById('btn-role-engineer').classList.remove('active');
    document.getElementById(`btn-role-${role}`).classList.add('active');
    
    document.getElementById('specialist-view').style.display = role === 'specialist' ? 'block' : 'none';
    document.getElementById('engineer-view').style.display = role === 'engineer' ? 'block' : 'none';
    
    const title = document.getElementById('main-title');
    if (title) title.innerText = role === 'specialist' ? "ARESGUARD: MISSION CONTROL" : "ARESGUARD: AUTOMATION ENGINE";
    
    if (role === 'engineer') fetchRules();
}

window.onload = initMissionControl;