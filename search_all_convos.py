import requests
import json

base_url = "https://api.prism.rod.dev"
headers = {
    "x-project": "prism",
    "x-username": "rodrigo"
}

try:
    print("Searching recent conversations...")
    # Get recent conversations list
    list_url = f"{base_url}/admin/conversations?limit=100"
    response = requests.get(list_url, headers=headers, timeout=30)
    response.raise_for_status()
    data = response.json()
    
    conversations = data.get("conversations", []) or data.get("data", []) or data.get("items", [])
    
    found = False
    for convo in conversations:
        convo_id = convo.get("id")
        detail_url = f"{base_url}/admin/conversations/{convo_id}"
        detail_resp = requests.get(detail_url, headers=headers, timeout=30)
        if detail_resp.status_code != 200:
            continue
        c = detail_resp.json()
        
        has_tool = False
        for msg in c.get('messages', []):
            if msg.get('toolCalls') or msg.get('tool_calls'):
                t_calls = msg.get('toolCalls') or msg.get('tool_calls') or []
                for tc in t_calls:
                    if tc.get('name') == 'discover_and_enable_tools':
                        has_tool = True
                        break
        
        if has_tool:
            print(f"\n=================== FOUND CONVERSATION {convo_id} ===================")
            print(f"Title: {c.get('title')}")
            print(f"Messages count: {len(c.get('messages', []))}")
            for idx, msg in enumerate(c.get('messages', [])):
                print(f"\nMessage [{idx}]: role={msg.get('role')}")
                if 'content' in msg:
                    print(f"  content: {repr(msg.get('content')[:120])}")
                if 'thinking' in msg:
                    print(f"  thinking: {repr(msg.get('thinking')[:120])}")
                if 'thinkingFragments' in msg:
                    print(f"  thinkingFragments: {msg.get('thinkingFragments')}")
                if 'contentSegments' in msg:
                    print(f"  contentSegments: {msg.get('contentSegments')}")
                if 'toolCalls' in msg:
                    print(f"  toolCalls: {json.dumps(msg.get('toolCalls'), indent=2)}")
            found = True
            break
            
    if not found:
        print("No conversation found containing 'discover_and_enable_tools'.")
except Exception as e:
    print(f"Error: {e}")
