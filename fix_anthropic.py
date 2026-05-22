import re

file_path = "/home/rodrigo/development/prism-service/src/providers/anthropic.ts"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace("interface AnthropicGenerateResult {", "export interface AnthropicGenerateResult {")

with open(file_path, "w") as f:
    f.write(content)
