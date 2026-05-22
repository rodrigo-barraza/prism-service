import re

file_path = "/home/rodrigo/development/prism-service/src/routes/WorkflowsRoutes.ts"
with open(file_path, "r") as f:
    content = f.read()

# Add Express types and Db
content = content.replace('import { Router } from "express";', 'import { Router, Request, Response, NextFunction } from "express";')

if "interface CustomRequest" not in content:
    content = content.replace('const router = Router();', '''import { Db } from "mongodb";

interface CustomRequest extends Request {
  db: Db;
  project?: string;
  username?: string;
}

const router = Router();''')

# Express handler types
content = content.replace("async (req: any, res: any, next: any)", "async (req: CustomRequest, res: Response, next: NextFunction)")

# value: any
content = content.replace("async function uploadIfDataUrl(\n  value: any,\n    category: any = \"uploads\",\n    project: any = null,", "async function uploadIfDataUrl(\n  value: unknown,\n    category: string = \"uploads\",\n    project: string | null = null,")
content = content.replace("value: any,", "value: unknown,")
content = content.replace("category: any = \"uploads\",", "category: string = \"uploads\",")
content = content.replace("project: any = null,", "project: string | null = null,")

content = content.replace("nodes: any,", "nodes: unknown[],")
content = content.replace("nodeResults: any,", "nodeResults: Record<string, unknown>,")

content = content.replace("value as any", "value as string")
content = content.replace("category as any", "category")
content = content.replace("project as any", "project")
content = content.replace("username as any", "username")

content = content.replace("typeof value === \"string\" && (value as any).startsWith(\"data:\")", "typeof value === \"string\" && value.startsWith(\"data:\")")
content = content.replace("FileService as any", "FileService")

content = content.replace("const processed: any[] = [];", "const processed: Record<string, unknown>[] = [];")
content = content.replace("const newMessages: any[] = [];", "const newMessages: Record<string, unknown>[] = [];")
content = content.replace("const array: any[] = [];", "const array: string[] = [];")
content = content.replace("const newReceived: any = {};", "const newReceived: Record<string, unknown> = {};")

content = content.replace("const processed: any = {};", "const processed: Record<string, unknown> = {};")
content = content.replace("const newOutputs: any = {};", "const newOutputs: Record<string, unknown> = {};")
content = content.replace("const msgs: any[] = [];", "const msgs: Record<string, unknown>[] = [];")

content = content.replace("resolveMinioRef(value: any, baseUrl: any)", "resolveMinioRef(value: unknown, baseUrl: string)")
content = content.replace("(value as any).startsWith(\"minio://\")", "(value as string).startsWith(\"minio://\")")
content = content.replace("(value as any).replace(\"minio://\", \"\")", "(value as string).replace(\"minio://\", \"\")")

content = content.replace("resolveWorkflowFileRefs(workflow: any, baseUrl: any)", "resolveWorkflowFileRefs(workflow: Record<string, unknown>, baseUrl: string)")

content = content.replace("getBaseUrl(req: any)", "getBaseUrl(req: Request)")
content = content.replace("(req as any).headers", "req.headers")
content = content.replace("(req as any).get(\"host\")", "req.get(\"host\")")

content = content.replace("computeWorkflowMeta(nodes: any)", "computeWorkflowMeta(nodes: Record<string, unknown>[])")
content = content.replace("const modalities: any = {};", "const modalities: Record<string, boolean> = {};")
content = content.replace("(nodes || [])\n        .filter((n: any) =>", "(nodes || [])\n        .filter((n: Record<string, unknown>) =>")
content = content.replace(".map((n: any) => n.provider)", ".map((n: Record<string, unknown>) => n.provider as string)")

content = content.replace("let filter: any;", "let filter: Record<string, unknown>;")

content = content.replace("(baseUrl as any)", "baseUrl")
content = content.replace("(finalNodes as any)", "finalNodes as Record<string, unknown>[]")

content = content.replace("sum: any, c: any", "sum: number, c: Record<string, unknown>")

# Handle missing type casts when pushing or spreading unknown
content = content.replace("const m = { ...message };", "const m = { ...(message as Record<string, unknown>) };")
content = content.replace("m[field] = array;", "(m as Record<string, unknown>)[field] = array;")
content = content.replace("m[field] = await", "(m as Record<string, unknown>)[field] = await")
content = content.replace("message[field]", "(message as Record<string, unknown>)[field]")
content = content.replace("outputs[mod]", "(outputs as Record<string, unknown>)[mod]")
content = content.replace("node.content", "(node as Record<string, unknown>).content")
content = content.replace("node.messages", "(node as Record<string, unknown>).messages")
content = content.replace("node.receivedOutputs", "(node as Record<string, unknown>).receivedOutputs")
content = content.replace("n.nodeType", "(n as Record<string, unknown>).nodeType")
content = content.replace("n.provider", "(n as Record<string, unknown>).provider")
content = content.replace("n.outputTypes", "(n as Record<string, unknown>).outputTypes")
content = content.replace("n.inputTypes", "(n as Record<string, unknown>).inputTypes")

with open(file_path, "w") as f:
    f.write(content)
