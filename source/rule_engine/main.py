import json, os, time, uuid, datetime, requests, pika, psycopg2, threading, uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- CONFIGURAZIONE ---
DB_CONFIG = os.getenv("DATABASE_URL", "host=aresguard_db dbname=aresguard user=ares password=mars2036")
BROKER_HOST = os.getenv("BROKER_HOST", "aresguard_broker")
RABBIT_USER = os.getenv("RABBITMQ_DEFAULT_USER", "ares")
RABBIT_PASS = os.getenv("RABBITMQ_DEFAULT_PASS", "mars2036")
base_url = os.getenv("SIMULATOR_URL", "http://mars_simulator:8080/api/actuators")
ACTUATORS_URL = base_url.rstrip("/")

EXCHANGE_NAME = "ares_telemetry_stream"
QUEUE_NAME = "rule_engine_queue"

# --- API SERVER ---
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class RulePayload(BaseModel):
    sensor_id: str
    operator: str
    threshold: float
    actuator_id: str
    action: str

def get_db():
    try: return psycopg2.connect(DB_CONFIG)
    except Exception as e: 
        print(f"[DB ERR] {e}", flush=True)
        return None

@app.post("/api/rules")
def add_rule(rule: RulePayload):
    conn = get_db()
    if not conn: raise HTTPException(500, "DB Connection Failed")
    try:
        cur = conn.cursor()
        
        # --- LOGICA DI RIMPIAZZO (UPSERT LOGIC) ---
        # Prima cancelliamo regole vecchie che agiscono sullo stesso sensore/attuatore con lo stesso operatore.
        # Esempio: Se c'era "Temp > 25 -> Fan ON" e ora inserisco "Temp > 28 -> Fan ON", la vecchia viene rimossa.
        cur.execute("""
            DELETE FROM rules 
            WHERE sensor_id = %s AND actuator_id = %s AND operator = %s
        """, (rule.sensor_id, rule.actuator_id, rule.operator))
        
        deleted_count = cur.rowcount
        
        # Inseriamo la nuova regola
        cur.execute("""
            INSERT INTO rules (sensor_id, operator, threshold, actuator_id, action_value) 
            VALUES (%s, %s, %s, %s, %s)
        """, (rule.sensor_id, rule.operator, rule.threshold, rule.actuator_id, rule.action))
        
        conn.commit()
        
        log_msg = "UPDATED" if deleted_count > 0 else "CREATED"
        print(f"[API] RULE {log_msg}: {rule.sensor_id} {rule.operator} {rule.threshold}", flush=True)
        
        return {"status": "saved", "mode": log_msg}
        
    except Exception as e:
        print(f"[API ERR] {e}", flush=True)
        raise HTTPException(500, str(e))
    finally: conn.close()

@app.get("/api/rules")
def get_rules():
    conn = get_db()
    if not conn: return []
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, sensor_id, operator, threshold, actuator_id, action_value FROM rules ORDER BY id DESC")
        return [{"rule_id": r[0], "sensor_id": r[1], "operator": r[2], "threshold": r[3], "actuator_id": r[4], "action": r[5]} for r in cur.fetchall()]
    except: return []
    finally: conn.close()

@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int):
    conn = get_db()
    if not conn: raise HTTPException(500, "DB Error")
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM rules WHERE id = %s", (rule_id,))
        conn.commit()
        return {"status": "deleted"}
    finally: conn.close()

# --- CONSUMER RABBITMQ ---
def check_cond(val, op, th):
    try:
        v = float(val)
        t = float(th)
        if op == '>': return v > t
        if op == '<': return v < t
        if op == '>=': return v >= t
        if op == '<=': return v <= t
        if op == '==' or op == '=': return v == t
        return False
    except ValueError: return False

def process_msg(ch, method, prop, body, conn):
    try:
        ev = json.loads(body)
        sid = ev['source']['identifier']
        raw_val = ev['payload']['value']
        
        if conn.closed: conn = get_db()
        cur = conn.cursor()
        
        # 1. Salva Telemetria
        try:
            cur.execute("INSERT INTO sensor_data (sensor_id, value, unit, timestamp) VALUES (%s, %s, %s, %s)",
                        (sid, str(raw_val), ev['payload'].get('unit', ''), ev['timestamp']))
        except: conn.rollback()

        # 2. MATCHING REGOLE
        cur.execute("SELECT operator, threshold, actuator_id, action_value, sensor_id FROM rules")
        rules = cur.fetchall()
        
        for op, th, act, act_val, rule_sid in rules:
            if rule_sid in sid or sid in rule_sid:
                if check_cond(raw_val, op, th):
                    print(f"[AUTO] ⚠️ TRIGGER! {sid} ({raw_val}) {op} {th}. Activating {act}...", flush=True)
                    
                    target_url = f"{ACTUATORS_URL}/{act}"
                    payload = {"state": act_val}
                    
                    try:
                        resp = requests.post(target_url, json=payload, timeout=5)
                        if resp.status_code >= 200 and resp.status_code < 300:
                            print(f"[AUTO] SUCCESS: {act} -> {act_val}", flush=True)
                            cur.execute("INSERT INTO audit_logs (command_id, timestamp, sensor_id, sensor_value, actuator_id, action_taken) VALUES (%s, %s, %s, %s, %s, %s)",
                                        (str(uuid.uuid4()), datetime.datetime.now(datetime.timezone.utc).isoformat(), sid, str(raw_val), act, act_val))
                        else:
                            print(f"[AUTO ERR] Simulator Response: {resp.status_code}", flush=True)
                    except Exception as e:
                        print(f"[AUTO ERR] Connection Failed: {e}", flush=True)
        
        conn.commit()
        ch.basic_ack(delivery_tag=method.delivery_tag)
    except Exception as e:
        print(f"[ERR] Processing: {e}", flush=True)
        ch.basic_ack(delivery_tag=method.delivery_tag)

def start_consumer():
    print("[RULE] ⏳ Connecting to RabbitMQ...", flush=True)
    while True:
        try:
            creds = pika.PlainCredentials(RABBIT_USER, RABBIT_PASS)
            conn = pika.BlockingConnection(pika.ConnectionParameters(host=BROKER_HOST, credentials=creds))
            ch = conn.channel()
            ch.exchange_declare(exchange=EXCHANGE_NAME, exchange_type='fanout', durable=True)
            ch.queue_declare(queue=QUEUE_NAME, durable=True)
            ch.queue_bind(exchange=EXCHANGE_NAME, queue=QUEUE_NAME)
            db = get_db()
            print("[RULE] 🟢 Consumer Connected!", flush=True)
            ch.basic_consume(queue=QUEUE_NAME, on_message_callback=lambda c, m, p, b: process_msg(c, m, p, b, db))
            ch.start_consuming()
        except Exception as e:
            print(f"[RULE] 🔴 Retry in 5s: {e}", flush=True)
            time.sleep(5)

if __name__ == "__main__":
    t = threading.Thread(target=start_consumer, daemon=True)
    t.start()
    print("[RULE] 🚀 API Server on 8000...", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=8000)