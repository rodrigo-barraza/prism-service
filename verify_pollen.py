import json
import requests

url = "https://api.prism.rod.dev/chat"
headers = {
    "Content-Type": "application/json",
    "x-project": "prism",
    "x-username": "rodrigo"
}
payload = {
    "provider": "lm-studio-2",
    "model": "google/gemma-4-12b-qat",
    "agent": "OMNI",
    "messages": [
        {"role": "user", "content": "what is the pollen quality like today"}
    ],
    "thinkingEnabled": True,
    "maxTokens": 2048,
    "temperature": 0.7
}

print("Sending request to OMNI agent...")
try:
    response = requests.post(url, headers=headers, json=payload, stream=True, timeout=90)
    response.raise_for_status()
    
    thinking_chunks = []
    text_chunks = []
    other_events = []
    
    for line in response.iter_lines():
        if not line:
            continue
        line_decoded = line.decode('utf-8')
        if line_decoded.startswith("data: "):
            try:
                data = json.loads(line_decoded[6:])
                event_type = data.get("type")
                if event_type == "thinking":
                    content = data.get("content", "")
                    thinking_chunks.append(content)
                    if len(thinking_chunks) <= 10:
                        print(f"[THINKING CHUNK {len(thinking_chunks)}] len={len(content)} repr={repr(content)}")
                elif event_type == "chunk":
                    content = data.get("content", "")
                    text_chunks.append(content)
                    if len(text_chunks) <= 10:
                        print(f"[TEXT CHUNK {len(text_chunks)}] len={len(content)} repr={repr(content)}")
                elif event_type == "done":
                    print(f"[DONE EVENT] {data}")
                else:
                    other_events.append(data)
                    if len(other_events) <= 5:
                        print(f"[EVENT: {event_type}] {data}")
            except Exception as e:
                print(f"Failed to parse line: {line_decoded[:100]} | Error: {e}")
                
    full_thinking = "".join(thinking_chunks)
    print("\n=== VERIFICATION RESULTS ===")
    print(f"Total thinking chunks: {len(thinking_chunks)}")
    print(f"Total text chunks: {len(text_chunks)}")
    print(f"Full thinking length: {len(full_thinking)}")
    if full_thinking:
        print(f"First 15 characters of thinking repr: {repr(full_thinking[:15])}")
        print(f"Starts with newline: {full_thinking.startswith(chr(10))}")
        print(f"First 200 characters of thinking content:\n{full_thinking[:200]}")
    else:
        print("No thinking content received!")
        
except Exception as e:
    print(f"Request failed: {e}")
