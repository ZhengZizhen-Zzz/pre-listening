import test from 'node:test';import assert from 'node:assert/strict';
import {soundLevel,createSoundCheck} from '../public/microphone-check.mjs';
test('静音和单次噪声不通过，持续声音才通过检测',()=>{assert.equal(soundLevel(new Float32Array(1024)),0);const gate=createSoundCheck();assert.equal(gate.sample(0.5),false);for(let i=0;i<10;i++)assert.equal(gate.sample(0),false);for(let i=0;i<3;i++)assert.equal(gate.sample(0.02),false);assert.equal(gate.sample(0.02),true);assert.ok(soundLevel([0.1,-0.1])>0.09);});
