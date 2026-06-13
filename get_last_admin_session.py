import requests
import json

base_url = "https://api.prism.rod.dev"
headers = {
    "x-project": "prism",
    "x-username": "rodrigo"
}

try:
    print("Searching for agent conversations...")
    list_url = f"{base_url}/admin/conversations?limit=100&type=agent"
    response = requests.get(list_url, headers=headers, timeout=30)
    response.raise_for_status()
    data = response.json()
    
    conversations = data.get("conversations", []) or data.get("data", []) or data.get("items", [])
    
    target_convo = None
    for convo in conversations:
        title = convo.get("title", "")
        if "pollen" in title.lower():
            target_convo = convo
            break
            
    if target_convo:
        convo_id = target_convo.get("id")
        print(f"Found target conversation ID: {convo_id}")
        
        detail_url = f"{base_url}/admin/conversations/{convo_id}"
        detail_resp = requests.get(detail_url, headers=headers, timeout=30)
        detail_resp.raise_for_status()
        convo = detail_resp.json()
        
        print(f"Convo ID: {convo.get('id')}")
        print(f"Title: {convo.get('title')}")
        print(f"Messages count: {len(convo.get('messages', []))}")
        
        for idx, msg in enumerate(convo.get('messages', [])):
            print(f"\nMessage [{idx}]: role={msg.get('role')}")
            for key in ["content", "thinking", "thinkingFragments", "contentSegments", "toolCalls"]:
                if key in msg:
                    val = msg.get(key)
                    if isinstance(val, list):
                        print(f"  {key}: length={len(val)} value={json.dumps(val)}")
                    else:
                        print(f"  {key}: {repr(val)}")
    else:
        print("No conversation found matching 'pollen'.")
except Exception as e:
    print(f"Error: {e}")
