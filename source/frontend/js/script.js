const host = window.location.hostname;

const ENDPOINTS = {
    WS: `ws://${host}:8000/ws`,
    API: `http://${host}:8000/api/commands`,
    SIMULATOR: `http://${host}:8080/api/sensors`,
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
let bootStartTime;
let currentRulesList = []; 
let editingRuleId = null; // TRACCIA L'ID DELLA REGOLA IN MODIFICA

function initMissionControl() {
    bootStartTime = Date.now();
    document.body.classList.add('no-scroll');
    renderGrid();
    renderEngineerViews();
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
        actuatorSelect.innerHTML = ACTUATOR_IDS.map(a => `<option value="${a}">${a}</option>`).join('');
    }
}

// --- FUNZIONE SAVE/UPDATE UNIFICATA ---
async function saveRule() {
    const sensorSimId = document.getElementById('rule-sensor').value;
    const operator = document.getElementById('rule-operator').value;
    const thresholdVal = document.getElementById('rule-value').value;
    const actuator = document.getElementById('rule-actuator').value;
    const action = document.getElementById('rule-action').value;
    
    const threshold = parseFloat(thresholdVal);
    
    if (isNaN(threshold)) { 
        alert("⚠️ Please enter a valid number."); 
        return; 
    }

    // VALIDAZIONE RANGE
    const config = SENSORS_REGISTRY.find(s => s.simId === sensorSimId);
    if (config) {
        if (threshold < config.min || threshold > config.max) {
            alert(`⚠️ INVALID VALUE!\n\nThe allowed range for ${config.label} is ${config.min} to ${config.max}.\nYou entered: ${threshold}`);
            return;
        }
    }
    
    const rule = { sensor_id: sensorSimId, operator: operator, threshold: threshold, actuator_id: actuator, action: action };
    
    try {
        // SE SIAMO IN EDIT MODE, CANCELLIAMO PRIMA LA VECCHIA REGOLA
        if (editingRuleId) {
            await fetch(`${ENDPOINTS.RULES}/${editingRuleId}`, { method: 'DELETE' });
        }

        // SALVIAMO LA NUOVA
        const res = await fetch(ENDPOINTS.RULES, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(rule)
        });
        
        if(!res.ok) throw new Error();
        
        fetchRules();
        
        const msg = editingRuleId 
            ? "✅ RULE UPDATED SUCCESSFULLY!" 
            : "✅ NEW RULE CREATED SUCCESSFULLY!";
            
        addLog(`Rule Configured: ${sensorSimId} ${operator} ${threshold}`, "#22c55e");
        alert(msg);

        // RESET UI DOPO IL SALVATAGGIO
        resetEditMode();
        
    } catch (e) {
        alert("Failed to save rule. Check backend.");
    }
}

// --- GESTIONE EDIT MODE ---
function editRule(ruleId) {
    const rule = currentRulesList.find(r => r.rule_id == ruleId);
    if (!rule) return;

    // Imposta stato di editing
    editingRuleId = ruleId;

    // Popola il form
    document.getElementById('rule-sensor').value = rule.sensor_id;
    document.getElementById('rule-sensor').onchange(); // Trigger per unità e limiti
    
    document.getElementById('rule-operator').value = rule.operator;
    document.getElementById('rule-value').value = rule.threshold;
    document.getElementById('rule-actuator').value = rule.actuator_id;
    document.getElementById('rule-action').value = rule.action;

    // Cambia il bottone per indicare l'update
    const saveBtn = document.querySelector('.btn-save');
    saveBtn.innerText = "↻ UPDATE RULE";
    saveBtn.style.background = "#3b82f6"; // Blu

    // Scroll al form
    document.querySelector('.rule-creation-card').scrollIntoView({ behavior: 'smooth' });
}

function resetEditMode() {
    editingRuleId = null;
    const saveBtn = document.querySelector('.btn-save');
    saveBtn.innerText = "+ SAVE TO DB";
    saveBtn.style.background = "#22c55e"; // Verde
    document.getElementById('rule-value').value = "";
}

async function fetchRules() {
    try { 
        const res = await fetch(ENDPOINTS.RULES); 
        if(!res.ok) throw new Error(); 
        currentRulesList = await res.json(); 
        renderRules(currentRulesList); 
    } catch (e) { 
        document.getElementById('rules-tbody').innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444;">Connection Error.</td></tr>`; 
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
                <button class="btn-del" onclick="deleteRule('${r.rule_id}')">\\ DELETE</button>
            </td>
        </tr>
    `).join('');
}

async function deleteRule(id) { 
    if(!confirm(`Delete rule ${id}?`)) return; 
    try { 
        await fetch(`${ENDPOINTS.RULES}/${id}`, { method: 'DELETE' }); 
        fetchRules(); 
        addLog(`Rule ${id} removed.`, "#ef4444"); 
        
        // Se stavo editando proprio quella regola, resetto il form
        if (editingRuleId == id) resetEditMode();
        
    } catch (e) { console.error(e); } 
}

function connect() {
    const socket = new WebSocket(ENDPOINTS.WS);
    socket.onopen = () => { document.getElementById('conn-status').innerText = "ONLINE"; document.getElementById('conn-status').style.color = "#22c55e"; };
    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === "FULL_STATE") {
                Object.values(msg.data).forEach((entry, index) => setTimeout(() => { processEventData(entry); checkBootSequence(); }, index));
            } else if (msg.type === "LIVE_UPDATE") {
                processEventData(msg.data); checkBootSequence();
            }
        } catch(e) {}
    };
    socket.onclose = () => setTimeout(connect, 3000);
}

function processEventData(entry) {
    if (!entry || !entry.source) return;
    const id = entry.source.identifier;
    const value = entry.payload.value;
    appendRawLog(entry);
    if (ACTUATOR_IDS.includes(id)) syncActuator(id, value);
    else {
        const regEntry = SENSORS_REGISTRY.find(s => s.simId === id);
        const targetId = regEntry ? regEntry.id : id;
        updateSensor(targetId, value);
        systemState.sensorsReceived.add(targetId);
    }
}

function appendRawLog(entry, isCommand = false) {
    const log = document.getElementById('raw-log-console');
    if (!log) return;
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    const blockId = `${time}-${isCommand ? "cmd" : "tel"}`;
    const firstChild = log.firstElementChild;
    if (firstChild && firstChild.dataset.blockId === blockId) return;
    
    const row = document.createElement('div');
    row.className = "raw-log-entry";
    row.dataset.blockId = blockId; 
    row.innerHTML = `${isCommand ? '<span style="color:#f59e0b;">> CMD:</span>' : '<span style="color:#22c55e;">> DATA:</span>'} <pre>${JSON.stringify(entry, null, 2)}</pre>`;
    log.prepend(row);
    if (log.children.length > 50) log.removeChild(log.lastChild);
}

function updateSensor(id, val) {
    const config = SENSORS_REGISTRY.find(s => s.id === id);
    if (!config) return;
    const valStr = typeof val === 'number' ? val.toFixed(1) : val;
    const elPrim = document.getElementById(`val-${id}`);
    if (elPrim) elPrim.innerText = valStr;
    if (document.getElementById(`val-sec-${id}`)) document.getElementById(`val-sec-${id}`).innerText = valStr;
    if (document.getElementById(`mini-val-${id}`)) document.getElementById(`mini-val-${id}`).innerHTML = `${valStr} <span style="font-size:9px;color:#555">${config.unit}</span>`;
    
    const bar = document.getElementById(`bar-${id}`);
    if (bar && typeof val === 'number') {
        let pct = ((val - config.min) / (config.max - config.min)) * 100;
        bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        bar.style.background = (val < config.min || val > config.max) ? '#ef4444' : '#22c55e';
    }
    
    const card = document.getElementById(`card-${id}`);
    const isCrit = (val > config.max || val < config.min);
    if (card) isCrit ? card.classList.add('card-alert') : card.classList.remove('card-alert');
    if (document.getElementById(`status-${id}`)) {
        document.getElementById(`status-${id}`).innerText = isCrit ? "● CRITICAL" : "● NORMAL";
        document.getElementById(`status-${id}`).className = `status-label ${isCrit ? 'status-crit' : 'status-ok'}`;
    }
    document.getElementById('critical-banner').style.display = document.querySelector('.card-alert') ? 'block' : 'none';
}

function syncActuator(id, rawState) {
    let newState = (String(rawState).toUpperCase() === "ON" || rawState === true) ? "ON" : "OFF";
    const toggle = document.getElementById(`toggle-${id}`);
    if (toggle) { toggle.checked = (newState === "ON"); toggle.disabled = false; }
    const txt = document.getElementById(`status-text-${id}`);
    if (txt) { txt.innerHTML = `STATUS: <span style="color: ${newState==="ON"?"#22c55e":"#555"}">${newState}</span>`; }
}

async function forceRefresh(id, event) {
    event.stopPropagation();
}

async function manualToggle(id, isChecked) {
    const toggle = document.getElementById(`toggle-${id}`);
    const currentState = systemState.actuators[id] === "ON";
    toggle.checked = currentState; toggle.disabled = true;
    if (toggle.nextElementSibling) toggle.nextElementSibling.style.opacity = "0.5";
    document.body.style.cursor = 'wait';
    const newState = isChecked ? "ON" : "OFF";
    addLog(`Manual CMD: Transmitting ${newState} to ${id}...`, "#3b82f6");
    const payload = { state: newState };
    appendRawLog({ command_id: "cmd-" + Math.random().toString(36).substr(2, 9), timestamp: new Date().toISOString(), target: { actuator_id: id, action: newState }, issued_by: "manual_override", payload: payload }, true);
    try {
        await fetch(`${ENDPOINTS.API}/${id}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ state: newState }) });
    } catch (e) {
        addLog(`Link Failure: ${id} command lost.`, "#ef4444");
        toggle.disabled = false;
        if (toggle.nextElementSibling) toggle.nextElementSibling.style.opacity = "1";
        document.body.style.cursor = 'default';
    }
}

function checkBootSequence() {
    if (systemState.booted) return;
    if (systemState.sensorsReceived.size >= 5) {
        systemState.booted = true;
        setTimeout(() => { document.getElementById('boot-overlay').style.display = 'none'; document.body.classList.remove('no-scroll'); }, 800);
    }
}

function toggleCardView(id) { document.getElementById(`card-${id}`).classList.toggle('active-view'); }
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
    document.getElementById('main-title').innerText = role === 'specialist' ? "ARESGUARD: MISSION CONTROL" : "ARESGUARD: AUTOMATION ENGINE";
    if (role === 'engineer') fetchRules();
}

window.onload = initMissionControl;