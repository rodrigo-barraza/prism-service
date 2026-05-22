import re

file_path = "/home/rodrigo/development/prism-service/src/routes/WorkflowsRoutes.ts"
with open(file_path, "r") as f:
    content = f.read()

# 1. Spread node
content = content.replace("const updated = { ...node };", "const updated = { ...(node as Record<string, unknown>) };")

# 2. Iterate node messages
content = content.replace("for ( const message of (node as Record<string, unknown>).messages)", "for ( const message of ((node as Record<string, unknown>).messages as Record<string, unknown>[]))")

# 3. Object.entries on receivedOutputs
content = content.replace("Object.entries((node as Record<string, unknown>).receivedOutputs)", "Object.entries((node as Record<string, unknown>).receivedOutputs as Record<string, unknown>)")

# 4. Assignment to receivedOutputs
content = content.replace("(node as Record<string, unknown>).receivedOutputs[mod]", "((node as Record<string, unknown>).receivedOutputs as Record<string, unknown>)[mod]")

# 5. Iterate outputTypes
content = content.replace("for ( const t of (n as Record<string, unknown>).outputTypes || [])", "for ( const t of ((n as Record<string, unknown>).outputTypes as string[]) || [])")

# 6. Iterate inputTypes
content = content.replace("for ( const t of (n as Record<string, unknown>).inputTypes || [])", "for ( const t of ((n as Record<string, unknown>).inputTypes as string[]) || [])")

with open(file_path, "w") as f:
    f.write(content)
