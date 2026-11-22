const fs = require("node:fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const src = (file) => fs.readFileSync(require("node:path").resolve(__dirname, "..", file==="index.html" ? file : "src/" + file),"utf8");

class Element {
  constructor(id) {
    this.id = id; this.value = ""; this.dataset = {}; this.children = []; this.events = {};
    this.attrs = new Map(); this.classes = new Set();
    this.classList = { add:(k)=>this.classes.add(k), remove:(k)=>this.classes.delete(k), contains:(k)=>this.classes.has(k), toggle:(k, on)=>{if(on??!this.classes.has(k))this.classes.add(k);else this.classes.delete(k);} };
    this.style = {setProperty:()=>{}};
  }
  addEventListener(kind, handler) { (this.events[kind] ??= []).push(handler); }
  emit(kind, more={}) { for(const handler of this.events[kind]||[]) handler({target:this, preventDefault(){}, stopPropagation(){}, ...more}); }
  setAttribute(key,value){this.attrs.set(key,String(value));}
  getAttribute(key){return this.attrs.get(key) ?? null;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children = items.flatMap(x=>x?.id==="fragment"?x.children:[x]);}
  add(option){this.options.push(option); option.owner = this;}
  blur(){} focus(){} matches(){return false;} closest(){return null;}
  querySelector(){return new Element("form");}
}
const nodes = new Map([...src("index.html").matchAll(/id="([^"]+)"/g)].map(x=>[x[1],new Element(x[1])]));
const get = (id) => {assert.ok(nodes.has(id),id+" is present");return nodes.get(id);};
get("instrument").options = ["steinway","grand"].map(value=>({value}));
get("settings").hidden = get("player").hidden = true;
get("sampleRoot").options = [];
get("customColor").parentElement = new Element("color-parent");
get("speed").value = "1";
for(const id of ["glow","bloom","density","trail","volume","reverb","release","seek"]) {get(id).min=0;get(id).max=id==="seek"?1000:100;}
const query = {};
for(const [attr, values] of Object.entries({mode:["free","step"],palette:["aurora","ice","ember","orchid"]})) {
  query["[data-"+attr+"]"] = values.map(v=>{const e=new Element(v); e.dataset[attr]=v;return e;});
}
query["[data-import-midi]"] = [new Element("import")];
query["[role=tab]"] = ["effects","sound","keys"].map(v=>{const e=get("tab-"+v);e.setAttribute("aria-controls","panel-"+v);return e;});
const browser = new Element("window"), document = new Element("document"), body = new Element("body");
Object.assign(document,{getElementById:get, querySelectorAll:(s)=>query[s]||[], createDocumentFragment:()=>new Element("fragment"), createElement:(t)=>new Element(t), body, activeElement:body });
const notes = [], lights = [], pending = [], prefs = {}, played = [];
const controller = { id: "test", name: "Test Piano", state: "connected" };
const device = { inputs: new Map([["test", controller]]) };
let timer=0;
const mock = {
  addEventListener:browser.addEventListener.bind(browser), document, HTMLElement:Element, HTMLInputElement:Element,
  console, navigator:{requestMIDIAccess: async()=>device}, performance:{now:()=>1000}, matchMedia:()=>({matches:false,addEventListener(){}}),
  localStorage:{getItem:()=>null,setItem:(k,v)=>{prefs[k]=JSON.parse(v);}},
  setTimeout:()=>++timer, clearTimeout(){}, requestAnimationFrame:(f)=>pending.push(f),
  Option:class{constructor(name,value){this.name=name;this.value=value;} remove(){this.owner.options=this.owner.options.filter(o=>o!==this);}},
  LumaAudio:class{wake(){return null;} loadGrand(){return Promise.resolve(30);} update(){} note(note, velocity, start, duration){
    notes.push(note);
    const voice={note, velocity, onsets:1, releases:[], stop(...args){this.releases.push(args);}};
    played.push(voice); return voice;
  } decode(){return Promise.resolve({});}},
  LumaVisual:class{color(){return "#33ffff";} strike(id,x){lights.push([id,x]);this.played=true;return this.color();} release(){} draw(){}}
};
mock.window=mock;
const runtime=vm.createContext(mock);
for(const file of ["midi.js","transport.js","app.js"]) vm.runInContext(src(file),runtime,{filename:file});
const send = (event, code, key, shiftKey=false) => browser.emit(event,{target:body,code,key,shiftKey});
const tap=(code,key,shift=false)=>{send("keydown",code,key,shift);send("keyup",code,key,shift);};

(async()=>{
  const tiles = get("keyboard").children;
  assert.equal(tiles.length,61);
  const white = tiles.filter((e)=>e.className.includes(" white"));
  const dark = tiles.filter((e)=>e.className.includes(" black"));
  assert.equal(white.length,36);
  assert.equal(dark.length,25);
  const physical = "1234567890qwertyuiopasdfghjklzxcvbnm";
  const naturals = [0,2,4,5,7,9,11];
  for (let i=0;i<physical.length;i++){
    const char=physical[i], expected=36+Math.floor(i/7)*12+naturals[i%7];
    const digit=/[0-9]/.test(char);
    const code = digit ? "Digit"+char : "Key"+char.toUpperCase();
    assert.equal(white[i].children.find((e)=>e.className==="key-bind").textContent,char);
    tap(code,char); assert.equal(notes.at(-1),expected);
    const count = notes.length;
    tap(code,digit?char:char.toUpperCase(),true);
    if ([0,2,5,7,9].includes(naturals[i%7])) {
      assert.equal(notes.length,count+1);
      assert.equal(notes.at(-1),expected+1);
    } else assert.equal(notes.length,count);
  }
  send("keydown","KeyT","\u0435"); send("keydown","KeyU","\u0433");
  assert.deepEqual(notes.slice(-2),[60,64]);
  assert.equal(get("keyboard").children.filter(e=>e.classList.contains("active")).length,2);
  send("keyup","KeyT","\u0435"); send("keyup","KeyU","\u0433");
  assert.equal(get("keyboard").children.filter(e=>e.classList.contains("active")).length,0);
  tap("BracketRight","]");tap("KeyT","t");assert.equal(notes.at(-1),72);
  query["[data-palette]"][1].emit("click");
  assert.equal(prefs["luma-keys-stage-v2"].palette,"ice");
  get("openSettings").emit("click");
  assert.equal(get("settings").hidden,false);
  tap("Escape","Escape");assert.equal(get("settings").hidden,true);
  tap("Escape","Escape");assert.ok(body.classList.contains("clean"));
  tap("Escape","Escape");assert.ok(!body.classList.contains("clean"));
  assert.equal(get("instrument").value,"steinway");
  assert.equal(get("touch").value,"balanced");
  tap("KeyT","t"); assert.equal(played.at(-1).velocity,.71);
  get("touch").value="soft"; get("touch").emit("change");
  tap("KeyT","t"); assert.equal(played.at(-1).velocity,.32);
  get("touch").value="strong"; get("touch").emit("change");
  tap("KeyT","t"); assert.equal(played.at(-1).velocity,.96);
  get("instrument").value="grand"; get("instrument").emit("change");
  assert.equal(prefs["luma-keys-stage-v2"].instrument,"grand");
  const sustain=get("sustain");
  assert.equal(sustain.getAttribute("aria-pressed"),"false");
  send("keydown","KeyT","t"); const damped=played.at(-1);
  send("keyup","KeyT","t"); assert.equal(damped.releases.length,1);

  send("keydown","Space"," ");
  assert.equal(sustain.classList.contains("pedal-down"),true);
  tap("KeyT","t"); const first=played.at(-1);
  tap("KeyT","t"); const second=played.at(-1);
  assert.notEqual(first,second);
  assert.deepEqual([first.releases.length,second.releases.length],[0,0]);
  assert.equal(get("keyboard").children.some((tile)=>tile.classList.contains("active")),false);
  send("keyup","Space"," ");
  assert.equal(sustain.classList.contains("pedal-down"),false);
  assert.deepEqual([first.releases.length,second.releases.length],[1,1]);

  sustain.emit("click");
  assert.equal(sustain.getAttribute("aria-pressed"),"true");
  tap("KeyU","u"); const latched=played.at(-1);
  tap("Space"," ");
  assert.equal(latched.releases.length,0);
  sustain.emit("click");
  assert.equal(latched.releases.length,1);
  assert.equal(prefs["luma-keys-stage-v2"].sustain,false);

  get("connectMidi").emit("click");
  await new Promise(setImmediate);
  assert.equal(get("deviceStatus").textContent,"Test Piano");
  assert.equal(get("midiInput").children.length,2);
  assert.equal(get("midiInput").value,"all");
  controller.onmidimessage({data:[0xb0,64,127]});
  controller.onmidimessage({data:[0x90,60,99]});
  const heldMidi=played.at(-1);
  controller.onmidimessage({data:[0x80,60,0]});
  assert.equal(heldMidi.releases.length,0);
  assert.equal(get("keyboard").children.some((tile)=>tile.classList.contains("active")),false);
  controller.onmidimessage({data:[0xb0,64,0]});
  assert.equal(heldMidi.releases.length,1);
  assert.equal(get("midiActivity").textContent,"C4 · 99/127");
  controller.onmidimessage({data:[0x90,61,108]});
  const unplugged=played.at(-1);
  controller.state="disconnected";
  device.onstatechange({port:controller});
  assert.equal(unplugged.releases.length,1);
  controller.state="connected";
  device.onstatechange({port:controller});
  controller.onmidimessage({data:[0x90,67,70]});
  assert.equal(played.at(-1).note,67);
  controller.onmidimessage({data:[0x90,67,0]});
  tap("Space"," ",true);
  assert.equal(get("play").getAttribute("aria-label"),"Pause MIDI");
  document.hidden=true; document.emit("visibilitychange"); browser.emit("blur");
  assert.equal(get("play").getAttribute("aria-label"),"Pause MIDI");
  document.hidden=false; document.emit("visibilitychange");
  tap("Space"," ",true);
  assert.equal(get("play").getAttribute("aria-label"),"Play MIDI");

  const chunk = (name, data) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from(name), size, Buffer.from(data)]);
  };
  const midiFile = Buffer.concat([
    chunk("MThd", [0,0,0,1,1,224]),
    chunk("MTrk", [0,144,60,100,0,64,90,0,67,99,131,96,144,60,0,0,64,0,0,67,0,0,144,72,88,131,96,128,72,0,0,255,47,0])
  ]);
  const b=midiFile.buffer.slice(midiFile.byteOffset,midiFile.byteOffset+midiFile.byteLength);
  const f={name:"fixture.mid",size:b.byteLength,arrayBuffer:async()=>b};
  get("midiFile").emit("change",{target:{files:[f]}});
  await new Promise(setImmediate);
  assert.equal(get("trackName").textContent,"fixture");
  assert.equal(get("player").hidden,false);
  assert.equal(query["[data-mode]"][1].getAttribute("aria-pressed"),"true");
  send("keydown","Space"," ");
  send("keydown","Digit8","8"); assert.deepEqual(notes.slice(-3),[60,64,67]);
  assert.equal(get("keyboard").children.filter((tile)=>tile.classList.contains("active")).length,3);
  const chord=played.slice(-3);
  send("keyup","Digit8","8");
  assert.equal(get("keyboard").children.filter((tile)=>tile.classList.contains("active")).length,0);
  assert.ok(chord.every((voice)=>voice.releases.length===0));
  send("keyup","Space"," ");
  assert.ok(chord.every((voice)=>voice.releases.length===1));
  tap("KeyF","f"); assert.equal(notes.at(-1),72);
  tap("KeyF","f"); assert.deepEqual(notes.slice(-3),[60,64,67]);
  get("restart").emit("click");assert.equal(get("seek").value,0);
  get("trackSelect").emit("change",{target:Object.assign(get("trackSelect"),{value:"demo"})});
  assert.equal(get("trackName").textContent,"Aurora");
  const w=new ArrayBuffer(44);
  get("sampleFile").emit("change",{target:{files:[{name:"fixture.wav",size:w.byteLength,arrayBuffer:async()=>w}]}});
  await new Promise(setImmediate);
  assert.ok(get("instrument").value.startsWith("local:"));
  assert.equal(get("sampleRootField").hidden,false);
  assert.ok(lights.length>=10);
  console.log("PASS: startup, physical code, simultaneous notes, octave, effects, clean UI, MIDI import and any-key chords, restart and selection, sample wiring.");
})().catch(error=>{console.error(error);process.exitCode=1;});

