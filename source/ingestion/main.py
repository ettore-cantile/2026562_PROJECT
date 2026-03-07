import time
import json
import os
import uuid
import datetime
import requests
import pika

raw_url = os.getenv("SIMULATOR_URL", "http://mars_simulator:8080/api")
base_url = raw_url.replace("/sensors", "").replace("/actuators", "").rstrip("/")

SENSORS_URL = f"{base_url}/sensors"
ACTUATORS_URL = f"{base_url}/actuators"

BROKER_HOST = os.getenv("BROKER_HOST", "aresguard_broker")
BROKER_USER = os.getenv("RABBITMQ_DEFAULT_USER", "ares")
BROKER_PASS = os.getenv("RABBITMQ_DEFAULT_PASS", "mars2036")

EXCHANGE_NAME = "ares_telemetry_stream"
POLLING_INTERVAL = 5

def get_rabbitmq_connection():
    credentials = pika.PlainCredentials(BROKER_USER, BROKER_PASS)
    while True:
        try:
            conn = pika.BlockingConnection(pika.ConnectionParameters(host=BROKER_HOST, credentials=credentials))
            print("[INGESTION] Connected to RabbitMQ.", flush=True)
            return conn
        except pika.exceptions.AMQPConnectionError:
            print("[INGESTION] Waiting for RabbitMQ...", flush=True)
            time.sleep(5)

def build_event(sid, val, unit=""):
    return {
        "event_id": str(uuid.uuid4()),
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": { "identifier": sid, "protocol": "rest_polling" },
        "payload": { "value": val, "unit": unit, "category": "telemetry" },
        "metadata": { "version": "1.0", "tags": ["polling", "normalized"] }
    }

def process_sensor_data(sid, data):
    events = []
    
    if 'measurements' in data and isinstance(data['measurements'], list):
        for m in data['measurements']:
            metric_name = m.get('name') or m.get('metric', '')
            val = m.get('value')
            unit = m.get('unit', '')
            specific_id = f"{sid}_{metric_name}" if metric_name else sid
            events.append(build_event(specific_id, val, unit))
            
    elif len([k for k in data.keys() if k not in ['unit', 'status', 'timestamp']]) > 1:
        for key, value in data.items():
            if key not in ['unit', 'status', 'timestamp'] and isinstance(value, (int, float)):
                events.append(build_event(f"{sid}_{key}", value, data.get('unit', '')))
                
    else:
        val = data.get('value') or data.get('level') or data.get('concentration') or data.get('ph')
        if val is None:
            val = 0
        events.append(build_event(sid, val, data.get('unit', '')))
        
    return events

def main():
    print(f"[INGESTION] Starting... Target: {SENSORS_URL}", flush=True)
    conn = get_rabbitmq_connection()
    ch = conn.channel()
    ch.exchange_declare(exchange=EXCHANGE_NAME, exchange_type='fanout', durable=True)
    
    while True:
        try:
            r = requests.get(SENSORS_URL, timeout=5)
            if r.status_code == 200:
                sensors = r.json().get("sensors", [])
                for sid in sensors:
                    try:
                        rd = requests.get(f"{SENSORS_URL}/{sid}", timeout=5).json()
                        evs = process_sensor_data(sid, rd)
                        for e in evs:
                            ch.basic_publish(exchange=EXCHANGE_NAME, routing_key='', body=json.dumps(e))
                    except requests.exceptions.RequestException:
                        pass
            
            r_act = requests.get(ACTUATORS_URL, timeout=5)
            if r_act.status_code == 200:
                actuators_dict = r_act.json().get("actuators", {})
                for aid, current_status in actuators_dict.items():
                    try:
                        event = build_event(aid, current_status, "")
                        ch.basic_publish(exchange=EXCHANGE_NAME, routing_key='', body=json.dumps(event))
                    except Exception as pub_e:
                        print(f"[INGESTION] Publish Error {aid}: {pub_e}", flush=True)
                        
        except Exception as e:
            print(f"[INGESTION] Polling Error: {e}", flush=True)
            
        time.sleep(POLLING_INTERVAL)

if __name__ == "__main__":
    main()