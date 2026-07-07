import os
import re

PRISM_DIR = '/home/rodrigo/development/prism-service'
TESTS_DIR = os.path.join(PRISM_DIR, 'tests')
SRC_DIR = os.path.join(PRISM_DIR, 'src')

unit_tests = [
    'anthropicProvider.test.ts',
    'client-tool-state-updaters.test.ts',
    'conversationEmbedding.test.ts',
    'conversationTimerService.test.ts',
    'dynamicToolDiscovery.test.ts',
    'googleProvider.test.ts',
    'harness-stream-processing.test.ts',
    'harnessHelpers.test.ts',
    'localProviderAdapters.test.ts',
    'miscUtilities.test.ts',
    'openaiProvider.test.ts',
    'orchestratorAutoResponse.test.ts',
    'orchestratorService.test.ts',
    'orchestratorServiceResume.test.ts',
    'specialtyProviders.test.ts',
    'subagentIntensive.test.ts',
    'thinkingMode.test.ts',
    'thoughtStructure.test.ts',
    'toolNameUniqueness.test.ts',
    'toolOrchestratorService.test.ts',
    'workflowExecution.test.ts'
]

mapping = {}

for test_file in unit_tests:
    path = os.path.join(TESTS_DIR, test_file)
    if not os.path.exists(path):
        continue
    with open(path, 'r') as f:
        content = f.read()
    
    # Find the first import from ../src/
    # We want to match something like: import Foo from '../src/services/Foo.ts'
    match = re.search(r"from ['\"](\.\./src/([^'\"/]+)/[^'\"]+)['\"]", content)
    if match:
        module = match.group(2)
        mapping[test_file] = f'src/{module}/__tests__/'
    else:
        mapping[test_file] = 'src/utils/__tests__/'

for k, v in sorted(mapping.items()):
    print(f'{k} -> {v}')
