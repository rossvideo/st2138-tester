import { scanGrpcDevice, scanRestDevice } from '../services/device-scan';
import { executeDeviceCommand } from '../services/command-execution';
import { runManualEndpoint } from '../services/manual-endpoint';
import { configureDeviceTransport, redactDeviceJwt } from './device-transport';
import { OpenApiSpecInfo } from '../openapi/openapi-spec';

export type OperationProgress = { type: 'progress'; message: string };

export type OperationMessage = {
  operation: 'rest' | 'grpc' | 'command' | 'endpoint';
  input: any;
  spec?: OpenApiSpecInfo;
};

process.once('message', async (message: OperationMessage) => {
  try {
    configureDeviceTransport(message.input.jwt, message.input.allowInsecureTls);
    const reportProgress = (progress: string) => {
      process.send?.({ type: 'progress', message: progress } satisfies OperationProgress);
    };
    let result: unknown;
    if (message.operation === 'rest') result = await scanRestDevice(message.input.url, message.spec, reportProgress);
    else if (message.operation === 'grpc') result = await scanGrpcDevice(message.input.url, reportProgress);
    else if (message.operation === 'command') result = await executeDeviceCommand(message.input);
    else if (message.operation === 'endpoint') result = await runManualEndpoint(message.input);
    else throw new Error('Unknown device operation.');
    const serialized = JSON.stringify(result);
    process.send?.({ result: JSON.parse(redactDeviceJwt(serialized)) }, () => process.exit(0));
  } catch (error) {
    const code = (error as any)?.code;
    const jwtRequired = code === 'jwt_required' || code === 16;
    process.send?.({
      error: jwtRequired ? 'JWT required for testing.' : redactDeviceJwt(error instanceof Error ? error.message : 'Device operation failed.'),
      ...(jwtRequired ? { code: 'jwt_required' } : {})
    }, () => process.exit(0));
  }
});