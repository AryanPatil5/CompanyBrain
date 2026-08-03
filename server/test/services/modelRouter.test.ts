import { routeCompletion } from '../../src/services/modelRouter.js';

export async function runModelRouterTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Enterprise Model Router Test Suite     ');
  console.log('=================================================');

  const req = {
    prompt: 'State the primary benefit of automated SOP execution.',
    systemPrompt: 'You are a concise enterprise assistant.',
    temperature: 0.1,
  };

  try {
    const res = await routeCompletion(req);

    if (!res.text || !res.provider || !res.model || !res.tokensUsed) {
      console.error('❌ MODEL ROUTER TEST FAILED: Response missing required fields!', res);
      return false;
    }

    if (typeof res.tokensUsed.input !== 'number' || typeof res.tokensUsed.output !== 'number') {
      console.error('❌ MODEL ROUTER TEST FAILED: Token accounting metrics invalid!', res.tokensUsed);
      return false;
    }

    console.log(`✅ MODEL ROUTER TEST PASSED: Successfully routed completion via provider "${res.provider}" (${res.model}). Tokens used: input=${res.tokensUsed.input}, output=${res.tokensUsed.output}.`);
    return true;
  } catch (err: any) {
    console.error('❌ MODEL ROUTER TEST EXCEPTION:', err.message);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runModelRouterTest().then((success) => {
    if (!success) process.exit(1);
  });
}
