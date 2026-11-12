import assert from 'node:assert/strict';
import test from 'node:test';
import {codexLimits,claudeLimits} from '../../packages/ai/src/limits.js';
test('provider usage windows preserve reset times and convert Claude fractional usage',()=>{
 assert.deepEqual(codexLimits({primary:{usedPercent:12,resetsAt:123},secondary:{usedPercent:45,windowDurationMins:10080}}),{five_hour:{used:12,resets:123},weekly:{used:45,resets:null}});
 assert.deepEqual(claudeLimits({unifiedWindows:{five_hour:{utilization:.125,resetsAt:123},seven_day:{utilization:.4}}}),{five_hour:{used:13,resets:123},weekly:{used:40,resets:null}});
 assert.deepEqual(claudeLimits({rateLimitType:'five_hour',utilization:.2}),{five_hour:{used:20,resets:null}});
 assert.deepEqual(codexLimits({primary:{usedPercent:Infinity}}),{});
});
