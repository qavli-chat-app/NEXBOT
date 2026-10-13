import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventStore } from '../lib/event-store.js';
import { createWorkflowEngine, validateWorkflow } from '../lib/workflow-engine.js';

const sample = () => ({
  name:'Greeting',
  enabled:true,
  nodes:[
    {id:'trigger',type:'incoming_message',config:{}},
    {id:'match',type:'exact_match',config:{value:'hello'}},
    {id:'reply',type:'send_text',config:{text:'Hello {{sender}}!'}},
    {id:'end',type:'end',config:{}}
  ],
  edges:[
    {from:'trigger',to:'match',when:'always'},
    {from:'match',to:'reply',when:'true'},
    {from:'match',to:'end',when:'false'},
    {from:'reply',to:'end',when:'always'}
  ]
});

test('workflow validator rejects missing connections and invalid nodes', () => {
  const invalid = sample();
  invalid.edges = invalid.edges.filter(e => e.from !== 'trigger');
  assert.ok(validateWorkflow(invalid).some(e => e.includes('Connect the incoming_message trigger')));
  const bad = sample();
  bad.nodes[2].config.text = '';
  assert.ok(validateWorkflow(bad).some(e => e.includes('reply text')));
});

test('workflow persists and runs matching replies; test mode has no side effects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexbot-workflows-'));
  try {
    const events = createEventStore(path.join(dir,'events.ndjson'));
    const sent = [];
    const opts = {filePath:path.join(dir,'workflows.json'),eventStore:events,sendText:async(c,t)=>sent.push(t)};
    const engine = createWorkflowEngine(opts);
    const saved = engine.save(sample());
    assert.equal(saved.ok,true);
    assert.equal(engine.list().length,1);
    const context = {jid:'123@g.us',sender:'123@s.whatsapp.net',text:'hello',isGroup:true,groupName:'Test'};
    const dry = await engine.test(saved.workflow.id,context);
    assert.equal(dry.ok,true);
    assert.equal(sent.length,0);
    const handled = await engine.runForMessage(context);
    assert.equal(handled,true);
    assert.deepEqual(sent,['Hello 123@s.whatsapp.net!']);
    const reloaded = createWorkflowEngine(opts);
    assert.equal(reloaded.list().length,1);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
