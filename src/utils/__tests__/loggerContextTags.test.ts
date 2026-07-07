import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROVIDERS } from "../../constants.ts";

const mockBaseLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@rodrigo-barraza/utilities-library/node', () => ({
  createLogger: vi.fn(() => mockBaseLogger),
}));

const mockGetRequestContext = vi.fn();
vi.mock('../RequestContext.ts', () => ({
  getRequestContext: mockGetRequestContext,
}));

let logger: typeof import('../logger.ts').default;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetRequestContext.mockReturnValue({
    project: 'any',
    username: 'any',
    clientIp: null,
  });
  const module = await import('../logger.ts');
  logger = module.default;
});

describe('logger.provider', () => {
  it('logs with provider name and action when no request context', () => {
    logger.provider(PROVIDERS.LM_STUDIO, 'Model loaded');
    expect(mockBaseLogger.info).toHaveBeenCalledOnce();
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('[lm-studio]');
    expect(logMessage).toContain('Model loaded');
  });

  it('appends project/username context tags when both are present', () => {
    mockGetRequestContext.mockReturnValue({
      project: 'prism',
      username: 'rodrigo',
      clientIp: null,
    });
    logger.provider(PROVIDERS.OPENAI, 'Request sent');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('[prism/rodrigo]');
  });

  it('appends only project tag when username is "any"', () => {
    mockGetRequestContext.mockReturnValue({
      project: 'prism',
      username: 'any',
      clientIp: null,
    });
    logger.provider(PROVIDERS.OPENAI, 'Request sent');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('[prism]');
    expect(logMessage).not.toContain('/any');
  });

  it('appends only username tag when project is "any"', () => {
    mockGetRequestContext.mockReturnValue({
      project: 'any',
      username: 'rodrigo',
      clientIp: null,
    });
    logger.provider(PROVIDERS.ANTHROPIC, 'Streaming');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('[rodrigo]');
    expect(logMessage).not.toContain('any/');
  });

  it('appends no identity tag when both are "any"', () => {
    mockGetRequestContext.mockReturnValue({
      project: 'any',
      username: 'any',
      clientIp: null,
    });
    logger.provider(PROVIDERS.GOOGLE, 'Embedding');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).not.toContain('[any]');
    expect(logMessage).toBe('[google] Embedding');
  });

  it('appends clientIp tag when present', () => {
    mockGetRequestContext.mockReturnValue({
      project: 'prism',
      username: 'rodrigo',
      clientIp: '192.168.1.1',
    });
    logger.provider(PROVIDERS.VLLM, 'Inference');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('(192.168.1.1)');
  });

  it('omits clientIp tag when null', () => {
    mockGetRequestContext.mockReturnValue({
      project: 'prism',
      username: 'rodrigo',
      clientIp: null,
    });
    logger.provider(PROVIDERS.VLLM, 'Inference');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).not.toContain('(');
  });
});

describe('logger.request', () => {
  it('logs with both project and username tags', () => {
    logger.request('prism', 'rodrigo', '10.0.0.1', 'Chat request');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('Chat request');
    expect(logMessage).toContain('[prism/rodrigo]');
    expect(logMessage).toContain('(10.0.0.1)');
  });

  it('logs with project only when username is absent', () => {
    logger.request('prism', '', null, 'Health check');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('[prism]');
  });

  it('logs with username only when project is absent', () => {
    logger.request('', 'rodrigo', null, 'Streaming');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('[rodrigo]');
  });

  it('logs with no tags when both project and username are absent', () => {
    logger.request('any', 'any', null, 'Anonymous request');
    const logMessage = mockBaseLogger.info.mock.calls[0][0];
    expect(logMessage).toBe('Anonymous request');
  });

  it('passes additional arguments through to the base logger', () => {
    logger.request('prism', 'rodrigo', null, 'Error occurred', { error: 'timeout' });
    expect(mockBaseLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Error occurred'),
      { error: 'timeout' },
    );
  });
});

describe('logger base methods', () => {
  it('exposes base logger warn method', () => {
    logger.warn('something happened');
    expect(mockBaseLogger.warn).toHaveBeenCalledWith('something happened');
  });

  it('exposes base logger error method', () => {
    logger.error('critical failure');
    expect(mockBaseLogger.error).toHaveBeenCalledWith('critical failure');
  });
});
