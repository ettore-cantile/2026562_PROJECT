const host = window.location.hostname;

const ENDPOINTS = {
    WS: `ws://${host}:8000/ws`,
    API: `http://${host}:8000/api/commands`
};

const SENSORS_REGISTRY = [
    { id: 'greenhouse_temperature_value', label: 'Greenhouse Temp', unit: '°C', min: 0, max: 40 },
    { id: 'entrance_humidity_value', label: 'Entrance Humidity', unit: '%', min: 0, max: 100 },
    { id: 'co2_hall_value', label: 'CO2 Hall Level', unit: 'ppm', min: 400, max: 1000 },
    { id: 'corridor_pressure_value', label: 'Corridor Pressure', unit: 'kPA', min: 90, max: 115 },
    { id: 'water_tank_level_level_pct', label: 'Water Tank Level', unit: '%', min: 0, max: 100 },
    { id: 'water_tank_level_level_liters', label: 'Water Tank Vol', unit: 'L', min: 0, max: 3000 },
    { id: 'hydroponic_ph_ph', label: 'Hydroponic pH', unit: 'pH', min: 4.0, max: 9.0 },
    { id: 'air_quality_pm25_pm25_ug_m3', label: 'PM 2.5 Level', unit: 'µg', min: 0, max: 50 },
    { id: 'air_quality_pm25_pm1_ug_m3', label: 'PM 1.0 Level', unit: 'µg', min: 0, max: 30 },
    { id: 'air_quality_pm25_pm10_ug_m3', label: 'PM 10 Level', unit: 'µg', min: 0, max: 60 },
    { id: 'air_quality_voc_voc_ppb', label: 'Volatile Org. Comp', unit: 'ppb', min: 0, max: 600 },
    { id: 'air_quality_voc_co2e_ppm', label: 'CO2 Equivalent', unit: 'ppm', min: 400, max: 1500 }
];

const ACTUATOR_IDS = ['cooling_fan', 'habitat_heater', 'hall_ventilation', 'entrance_humidifier'];

let systemState = {
    booted: false,
    sensorsReceived: new Set(),
    actuators: {} 
};

function initMissionControl() {
    document.body.classList.add('no-scroll');
    renderGrid();
    connect();
}

function renderGrid() {
    const grid = document.getElementById('sensor-grid');
    if (!grid) return;
    grid.innerHTML = SENSORS_REGISTRY.map(s => `
        <div class="sensor-card" id="card-${s.id}" onclick="toggleCardView('${s.id}')">
            <div class="view-primary">
                <span class="status-label status-ok" id="status-${s.id}">● NORMAL</span>
                <div class="sensor-value-group">
                    <h2 id="val-${s.id}">--.-</h2>
                    <span class="unit">${s.unit}</span>
                </div>
                <p class="sensor-label">${s.label}</p>
            </div>
            <div class="view-secondary">
                <span class="status-label" style="color:#aaa;">MONITORING RANGE</span>
                <div class="sensor-value-group">
                    <h2 id="val-sec-${s.id}">--.-</h2>
                    <span class="unit">${s.unit}</span>
                </div>
                <div class="mini-progress-container">
                    <div class="mini-progress-bar" id="bar-${s.id}" style="width: 0%;"></div>
                </div>
                <div style="display:flex; justify-content:space-between; width:100%;">
                    <p class="sensor-label">MIN: ${s.min}</p>
                    <p class="sensor-label">MAX: ${s.max}</p>
                </div>
            </div>
        </div>
    `).join('');
}

function connect() {
    const socket = new WebSocket(ENDPOINTS.WS);

    socket.onopen = () => {
        const statusEl = document.getElementById('conn-status');
        if (statusEl) {
            statusEl.innerText = "ONLINE";
            statusEl.style.color = "#22c55e";
        }
        addLog("Data Uplink Established.", "#22c55e");
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            
            if (msg.type === "FULL_STATE") {
                const items = Object.values(msg.data);
                items.forEach((entry, index) => {
                    setTimeout(() => {
                        processEventData(entry);
                        checkBootSequence();
                    }, index * 150); 
                });
            } else if (msg.type === "LIVE_UPDATE") {
                processEventData(msg.data);
                checkBootSequence();
            }
        } catch(e) {}
    };

    socket.onclose = () => setTimeout(connect, 3000);
}

function processEventData(entry) {
    if (!entry || !entry.source || !entry.payload) return;
    const id = entry.source.identifier;
    const value = entry.payload.value;

    if (ACTUATOR_IDS.includes(id)) {
        syncActuator(id, value);
    } else {
        updateSensor(id, value);
        systemState.sensorsReceived.add(id);
    }
}

function updateSensor(id, val) {
    const config = SENSORS_REGISTRY.find(s => s.id === id);
    if (!config) return;

    const valStr = typeof val === 'number' ? val.toFixed(1) : val;
    
    const elPrim = document.getElementById(`val-${id}`);
    const elSec = document.getElementById(`val-sec-${id}`);
    if (elPrim) elPrim.innerText = valStr;
    if (elSec) elSec.innerText = valStr;

    const bar = document.getElementById(`bar-${id}`);
    if (bar && typeof val === 'number') {
        let pct = ((val - config.min) / (config.max - config.min)) * 100;
        pct = Math.max(0, Math.min(100, pct));
        bar.style.width = `${pct}%`;
        bar.style.background = (val < config.min || val > config.max) ? '#ef4444' : '#22c55e';
    }

    const card = document.getElementById(`card-${id}`);
    const statusEl = document.getElementById(`status-${id}`);
    
    let state = "NORMAL";
    let cssClass = "status-ok";
    let isCrit = false;

    if (val > config.max || val < config.min) {
        state = "CRITICAL";
        cssClass = "status-crit";
        isCrit = true;
    }

    if (statusEl) {
        statusEl.innerText = `● ${state}`;
        statusEl.className = `status-label ${cssClass}`;
    }

    if (card) {
        if (isCrit) card.classList.add('card-alert');
        else card.classList.remove('card-alert');
    }

    const banner = document.getElementById('critical-banner');
    if (banner) {
        banner.style.display = document.querySelector('.card-alert') ? 'block' : 'none';
    }
}

function syncActuator(id, rawState) {
    let newState = String(rawState).toUpperCase();
    if (newState === "TRUE" || newState === "ON" || newState === "1") newState = "ON";
    else newState = "OFF";

    const toggle = document.getElementById(`toggle-${id}`);
    if (toggle) {
        toggle.checked = (newState === "ON");
        toggle.disabled = false; 
        if (toggle.nextElementSibling) {
            toggle.nextElementSibling.style.opacity = "1"; 
        }
    }

    const statusText = document.getElementById(`status-text-${id}`);
    if (statusText) {
        const color = (newState === "ON") ? "#22c55e" : "#555"; 
        statusText.innerHTML = `STATUS: <span style="color: ${color}">${newState}</span>`;
    }

    if (systemState.actuators[id] !== newState) {
        systemState.actuators[id] = newState;
        addLog(`System Confirmed: ${id} is ${newState}`, "#f59e0b");
    }

    document.body.style.cursor = 'default';
}

async function manualToggle(id, isChecked) {
    const toggle = document.getElementById(`toggle-${id}`);
    const currentState = systemState.actuators[id] === "ON";
    toggle.checked = currentState;

    toggle.disabled = true;
    if (toggle.nextElementSibling) {
        toggle.nextElementSibling.style.opacity = "0.5";
    }

    document.body.style.cursor = 'wait';

    const newState = isChecked ? "ON" : "OFF";
    addLog(`Manual CMD: Transmitting ${newState} to ${id}...`, "#3b82f6");
    
    try {
        await fetch(`${ENDPOINTS.API}/${id}`, {
            method: 'POST', 
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ state: newState })
        });
    } catch (e) {
        addLog(`Link Failure: ${id} command lost.`, "#ef4444");
        toggle.disabled = false;
        if (toggle.nextElementSibling) {
            toggle.nextElementSibling.style.opacity = "1";
        }
        document.body.style.cursor = 'default';
    }
}

function checkBootSequence() {
    if (systemState.booted) return;
    const count = systemState.sensorsReceived.size;
    const total = SENSORS_REGISTRY.length;
    const bar = document.getElementById('boot-progress');
    const log = document.getElementById('boot-log');

    if (bar) bar.style.width = `${(count / total) * 100}%`;
    if (log) log.innerHTML = `Loading Modules<span class="bouncing-dots"><span>.</span><span>.</span><span>.</span></span> (${count}/${total})`;

    if (count >= 5) {
        systemState.booted = true;
        const overlay = document.getElementById('boot-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => { 
                overlay.style.display = 'none'; 
                document.body.classList.remove('no-scroll');
                addLog("AresGuard Online. Mission Active.", "#22c55e");
            }, 800);
        }
    }
}

function toggleCardView(id) { 
    const card = document.getElementById(`card-${id}`);
    if (card) card.classList.toggle('active-view'); 
}

function addLog(msg, color) {
    const log = document.getElementById('log-console');
    if (!log) return;
    const row = document.createElement('div');
    row.innerHTML = `<span style="color:#555">[${new Date().toLocaleTimeString()}]</span> <span style="color:${color}">${msg}</span>`;
    log.prepend(row);
}

function updateRole() {
    const role = document.getElementById('user-role').value;
    const controls = document.getElementById('controls-section');
    if (controls) {
        controls.style.opacity = role === 'specialist' ? '1' : '0.5';
        controls.style.pointerEvents = role === 'specialist' ? 'auto' : 'none';
    }
    addLog(`Access Level: ${role.toUpperCase()}`, "#fff");
}

window.onload = initMissionControl;