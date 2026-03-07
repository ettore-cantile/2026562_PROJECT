import json
import os
import time
import uuid
import datetime
import requests
import pika
import psycopg2

DB_CONFIG = os.getenv("DATABASE_URL", "host=aresguard_db dbname=aresguard user=ares password=mars2036")
BROKER_HOST = os.getenv("BROKER_HOST", "aresguard_broker")
RABBIT_USER = os.getenv("RABBITMQ_DEFAULT_USER", "ares")
RABBIT_PASS = os.getenv("RABBITMQ_DEFAULT_PASS", "mars2036")

raw_url = os.getenv("SIMULATOR_URL", "http://mars_simulator:8080/api")
API_BASE = raw_url.replace("/sensors", "").replace("/actuators", "").rstrip("/")
ACTUATORS_URL = f"{API_BASE}/actuators"

EXCHANGE_NAME = "ares_telemetry_stream"
QUEUE_NAME = "rule_engine_queue"

def get_db_connection():
    while True:
        try:
            conn = psycopg2.connect(DB_CONFIG)
            print("[RULE_ENGINE] Database connected successfully.", flush=True)
            return conn
        except psycopg2.OperationalError:
            print("[RULE_ENGINE] Waiting for database...", flush=True)
            time.sleep(5)

def check_condition(val, op, thresh):
    try:
        val = float(val)
        thresh = float(thresh)
        if op == '>': return val > thresh
        if op == '<': return val < thresh
        if op == '>=': return val >= thresh
        if op == '<=': return val <= thresh
        if op in ['=', '==']: return val == thresh
    except ValueError:
        if op in ['=', '==']: return str(val) == str(thresh)
    return False

def process_event(ch, method, properties, body, conn):
    try:
        event = json.loads(body)
        sid = event['source']['identifier']
        val = event['payload']['value']
        timestamp = event['timestamp']

        cur = conn.cursor()
        
        try:
            cur.execute(
                "INSERT INTO sensor_data (sensor_id, value, unit, timestamp) VALUES (%s, %s, %s, %s)",
                (sid, str(val), event['payload'].get('unit', ''), timestamp)
            )
        except Exception as e:
            print(f"[RULE_ENGINE] Data insert error: {e}", flush=True)
            conn.rollback()
        
        cur.execute("SELECT operator, threshold, actuator_id, action_value FROM rules WHERE sensor_id = %s", (sid,))
        rules = cur.fetchall()
        
        for op, thresh, act, act_val in rules:
            if check_condition(val, op, thresh):
                req_body = {"state": act_val}
                res = requests.post(f"{ACTUATORS_URL}/{act}", json=req_body, timeout=5)
                
                if res.status_code in [200, 201]:
                    print(f"[RULE_ENGINE] RULE TRIGGERED: {sid} {op} {thresh} -> Set {act} to {act_val}", flush=True)
                    cmd_id = str(uuid.uuid4())
                    cur.execute(
                        "INSERT INTO audit_logs (command_id, timestamp, sensor_id, sensor_value, actuator_id, action_taken) VALUES (%s, %s, %s, %s, %s, %s)",
                        (cmd_id, datetime.datetime.now(datetime.timezone.utc).isoformat(), sid, str(val), act, act_val)
                    )
        
        conn.commit()
        cur.close()
        ch.basic_ack(delivery_tag=method.delivery_tag)
        
    except psycopg2.InterfaceError:
        pass
    except Exception as e:
        print(f"[RULE_ENGINE] Processing error: {e}", flush=True)
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

def main():
    print("[RULE_ENGINE] Starting service...", flush=True)
    creds = pika.PlainCredentials(RABBIT_USER, RABBIT_PASS)
    conn_db = get_db_connection()
    
    while True:
        try:
            conn_rabbit = pika.BlockingConnection(pika.ConnectionParameters(host=BROKER_HOST, credentials=creds))
            ch = conn_rabbit.channel()
            
            ch.exchange_declare(exchange=EXCHANGE_NAME, exchange_type='fanout', durable=True)
            ch.queue_declare(queue=QUEUE_NAME, durable=True)
            ch.queue_bind(exchange=EXCHANGE_NAME, queue=QUEUE_NAME)
            
            ch.basic_qos(prefetch_count=10)
            ch.basic_consume(queue=QUEUE_NAME, on_message_callback=lambda c, m, p, b: process_event(c, m, p, b, conn_db), auto_ack=False)
            
            print("[RULE_ENGINE] Connected to RabbitMQ. Listening for events...", flush=True)
            ch.start_consuming()
        except pika.exceptions.AMQPConnectionError:
            print("[RULE_ENGINE] Waiting for RabbitMQ...", flush=True)
            time.sleep(5)
        except psycopg2.InterfaceError:
            print("[RULE_ENGINE] Database connection lost. Reconnecting...", flush=True)
            conn_db = get_db_connection()
        except Exception as e:
            print(f"[RULE_ENGINE] Critical error: {e}", flush=True)
            time.sleep(5)

if __name__ == "__main__":
    main()