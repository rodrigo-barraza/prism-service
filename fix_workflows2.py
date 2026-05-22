import re

file_path = "/home/rodrigo/development/prism-service/src/routes/WorkflowsRoutes.ts"
with open(file_path, "r") as f:
    content = f.read()

# Fix project | undefined syntax error
content = content.replace("(project | undefined)", "project")
content = content.replace("(username | undefined)", "username")

# Fix sum + totalCost
content = content.replace("sum + (c.totalCost || 0)", "sum + ((c.totalCost as number) || 0)")

# Fix req.params.id string array warning
content = content.replace("new ObjectId(req.params.id)", "new ObjectId(req.params.id as string)")

# Fix $push typing mismatch
content = content.replace("$push: { conversationIds: { $each: conversationIds } },", "$push: { conversationIds: { $each: conversationIds } } as any,")

with open(file_path, "w") as f:
    f.write(content)
