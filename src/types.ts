export interface DotNetProcess {
    pid: number;
    name: string;
    commandLine: string;
}

export interface DumpObjField {
    name: string;
    type: string;
    value: string;
    isStatic: boolean;
    offset: string;
    isReference: boolean;
}

export interface DumpObjResult {
    header: string[];
    fields: DumpObjField[];
}

export interface CounterEvent {
    timestamp: string;
    provider: string;
    name: string;
    tags: string;
    counterType: string;
    value: number;
}

export interface CounterData {
    TargetProcess: string;
    StartTime: string;
    Events: CounterEvent[];
}

export interface HeapObject {
    address: string;
    size: number;
}

export interface GcDumpEntry {
    type: string;
    count: number;
    bytes: number;
}

export interface CpuTraceEntry {
    function: string;
    inclusivePercent: number;
    exclusivePercent: number;
}
