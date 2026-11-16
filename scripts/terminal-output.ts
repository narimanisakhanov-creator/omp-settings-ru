/** Clean accumulated PTY output for text observations, not screen emulation. */
export function cleanTerminalOutput(text: string): string {
  // Stop at the first BEL or ST: a later OSC in a differential repaint must
  // never consume visible status text that was written between the sequences.
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>]/g, "");
}

export interface TerminalOffsetReset { at: number; from: number; to: number }

/** Bounded failure metadata; offsets refer to JS UTF-16 strings, not screen cells. */
export function terminalObservationSummary(raw: string, offset: number, setupResets: readonly TerminalOffsetReset[] = [], setupResetCount = setupResets.length) {
  const clean = cleanTerminalOutput(raw);
  const window = cleanTerminalOutput(raw.slice(offset));
  const windowRaw = raw.slice(offset);
  function positions(text: string, marker: string) {
    let count = 0;
    let first = -1;
    let last = -1;
    for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + marker.length)) {
      if (first === -1) first = index;
      last = index;
      count++;
    }
    return { count, first, last };
  }
  function marker(text: string) {
    return { raw: positions(raw, text), clean: positions(clean, text), windowRaw: positions(windowRaw, text), window: positions(window, text) };
  }
  return {
    units: "utf16", rawLength: raw.length, offset, windowLength: raw.length - offset,
    setupResetCount, setupResets: setupResets.slice(-8),
    markers: { noModel: marker("no-model"), hint: marker("change thinking effort"), setup: marker("Setup step") },
  };
}

/** Keep evidence inside the installed driver's outer 4000-character stderr tail. */
export function terminalObservationFailure(raw: string, offset: number, setupResets: readonly TerminalOffsetReset[] = [], setupResetCount = setupResets.length, ownedPaths: readonly string[] = []): string {
  const summary = terminalObservationSummary(raw, offset, setupResets, setupResetCount);
  const tuple = (position: {count:number;first:number;last:number}) => [position.count,position.first,position.last];
  const markers = Object.fromEntries(Object.entries(summary.markers).map(([name, marker]) => [name, {
    raw:tuple(marker.raw),clean:tuple(marker.clean),windowRaw:tuple(marker.windowRaw),windowClean:tuple(marker.window),
  }]));
  // Drop complete and incomplete string-control payloads before publishing text.
  let display = cleanTerminalOutput(raw.replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|[_P^X][\s\S]*?(?:\x1b\\|$))/g,""));
  for(const path of ownedPaths) {
    if(!path)continue;
    for(const variant of new Set([path,path.replaceAll("\\","/"),path.replaceAll("/","\\")]))display=display.replaceAll(variant,"[owned-path]");
  }
  const markerIndex = [summary.markers.noModel.raw.first,summary.markers.hint.raw.first,summary.markers.setup.raw.first].find(index=>index>=0) ?? 0;
  const rawControls: {offset:number;end:number;kind:string;type:string;terminator:string}[] = [];
  for(const match of raw.matchAll(/\x1b\](\d*)[\s\S]*?(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]/g)) {
    const end=match.index+match[0].length;
    if(end<markerIndex-128 || match.index>markerIndex+128)continue;
    rawControls.push({offset:match.index,end,kind:match[1]===undefined?"CSI":"OSC",type:match[1]?.slice(0,8)??"",terminator:match[1]===undefined?"":match[0].endsWith("\x07")?"BEL":match[0].endsWith("\x1b\\")?"ST":"incomplete"});
    if(rawControls.length===8)break;
  }
  const evidence = {
    units:summary.units,rawLength:summary.rawLength,offset,windowLength:summary.windowLength,
    setupResetCount,setupResets:summary.setupResets,markerColumns:"count,first,last",markers,
    head:display.slice(0,1200),tail:display.slice(-400),rawControls,
  };
  let json = JSON.stringify(evidence);
  while(json.length>2600) {
    const field = evidence.head.length>0 ? "head" : "tail";
    if(evidence[field].length===0)break;
    evidence[field]=evidence[field].slice(0,Math.max(0,evidence[field].length-(json.length-2600)));
    json=JSON.stringify(evidence);
  }
  return json;
}
