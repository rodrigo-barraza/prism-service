import re

file_path_memory = "/home/rodrigo/development/prism-service/src/routes/MemoryRoutes.ts"
with open(file_path_memory, "r") as f:
    memory = f.read()

memory = memory.replace("traceId: traceId || null,", "traceId: traceId || undefined,")

with open(file_path_memory, "w") as f:
    f.write(memory)


file_path_service = "/home/rodrigo/development/prism-service/src/services/MemoryService.ts"
with open(file_path_service, "r") as f:
    service = f.read()

service = service.replace(") as ExtractedFact[];", ") as unknown as ExtractedFact[];")

with open(file_path_service, "w") as f:
    f.write(service)
