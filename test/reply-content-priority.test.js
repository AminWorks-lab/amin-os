import test from 'node:test';
import assert from 'node:assert/strict';
import {generateOptions} from '../apps/reply/generator.js';
import {contentInstruction,NONE_STYLE} from '../apps/reply/writing-library.js';
import {initializeAI} from '../ai/service.js';
import {compilePreset} from '../ai/presets.js';

const selected={id:'custom',name:'克制',description:'CONTENT_RULE：禁止威胁，所有选项以耐心沟通解决分歧。'};
const ctx=generateRaw=>({chat:[{name:'甲',mes:'CONTEXT：门口发生争执。'}],name1:'乙',characters:[],generateRaw});
for(const writingMode of ['roleplay','author'])test(`${writingMode}: selected content wins over conflicting custom/style/refinement instructions and remains last`,async()=>{
    let sent;
    await generateOptions(ctx(async request=>{sent=request;return '{"options":[{"text":"耐心询问原因。"}]}';}),{
        writingMode,prompt:'CUSTOM：威胁对方。',authorPrompt:'AUTHOR：让局势紧张。',
        roleplaySystemPrompt:'BASE：语气急躁。',authorSystemPrompt:'BASE：制造争执。',
    },{world:[],directions:['观察'],contentStyle:selected,
        writingStyle:{mode:'custom',preset:{name:'激烈',description:'PROSE：用激烈语言。'}},
        revisionTask:{original:'先等等。',instruction:'REFINE：更直接。'},
    });
    assert.ok(sent.systemPrompt.indexOf('CONTENT_RULE')>sent.systemPrompt.indexOf('BASE'));
    assert.ok(sent.systemPrompt.indexOf('CONTENT_RULE')>sent.systemPrompt.indexOf('REFINE'));
    assert.ok(sent.prompt.lastIndexOf('CONTENT_RULE')>sent.prompt.indexOf('CONTEXT'));
    assert.ok(sent.prompt.lastIndexOf('CONTENT_RULE')>sent.prompt.lastIndexOf('REFINE'));
    assert.match(sent.systemPrompt,/所有创作要求中最高优先级/);
    assert.match(sent.prompt,/发生创作要求冲突|与角色定位、自定义要求、单条修改要求/);
});
test('empty content prompts remain empty instead of inventing a rule from the name',()=>{
    assert.equal(contentInstruction(NONE_STYLE),'');
    assert.equal(contentInstruction({name:'自定义风格',description:'   '}),'');
});
test('shared preset request block retains full highest-priority content rules',async()=>{
    const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
    const ai=initializeAI(storage,'priority',{getHostContext:()=>({})});
    ai.generate=async(_task,_ctx,request,options)=>{
        const messages=compilePreset({id:'request-only',name:'仅任务',blocks:[{type:'request',role:'user',enabled:true,text:''}]},options.data);
        assert.match(messages[0].content,/CONTENT_RULE/);
        assert.match(messages[0].content,/最高优先级/);
        assert.match(request.systemPrompt,/CONTENT_RULE/);
        return '{"options":[{"text":"耐心询问原因。"}]}';
    };
    await generateOptions(ctx(),{}, {world:[],directions:['交涉'],contentStyle:selected});
});
