# DotNet Profiler for VS Code

A VS Code extension that brings Visual Studio-style profiling tools to VS Code. Monitor, analyze, and optimize your .NET applications directly from your editor.

## Features

![DotNet Profiler Screenshot](https://github.com/ghostbust555/dotnetprofilerforvscode/blob/master/image.png?raw=true)

### Real-time Performance Monitoring
- **CPU Usage** - Live CPU utilization chart with configurable time windows (30s, 1min, 5min)
- **Memory Usage** - Track working set and GC heap size over time
- **Auto-detection** - Automatically detects .NET debug sessions and offers to start monitoring

### Memory Analysis
- **Heap Snapshots** - Capture GC heap snapshots showing object counts and sizes by type
- **Delta Tracking** - Compare snapshots to identify memory growth between captures
- **Object Inspection** - Click any type to explore individual object instances
- **Field Drilling** - Inspect object fields with automatic type resolution and primitive value display
- **GC Root Analysis** - Find what's keeping objects alive with `gcroot` integration
- **Export to File** - Save `.gcdump` files for offline analysis
- **Terminal Access** - Open dumps directly in `dotnet-dump analyze` for advanced SOS commands

### CPU Profiling
- **CPU Traces** - Capture CPU samples with configurable duration (3-30 seconds)
- **Hot Path Analysis** - View functions by inclusive and exclusive CPU time
- **Speedscope Integration** - Export traces to Speedscope for flame graph visualization

### AI-Powered Analysis (Copilot)
- **Intelligent Insights** - Ask GitHub Copilot to analyze your profiling data
- **Workspace Awareness** - AI has access to your project structure and open files
- **Quick Suggestions** - Pre-built prompts for common analysis tasks:
  - Memory consumption analysis
  - CPU hotspot identification
  - Memory leak detection
  - Performance summaries

## Requirements

- VS Code 1.90.0 or later
- .NET SDK with diagnostic tools:
  - `dotnet-counters` - Real-time performance monitoring
  - `dotnet-gcdump` - Memory snapshots
  - `dotnet-dump` - Heap analysis
  - `dotnet-trace` - CPU profiling

The extension will prompt to install any missing tools automatically.

For AI features, [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) must be installed and signed in.

## Usage

### Starting the Profiler

1. **From Command Palette**: Run `DotNet Profiler: Start Monitoring`
2. **During Debugging**: When a .NET debug session starts, you'll be prompted to start monitoring
3. Select your target .NET process from the list

### Taking Snapshots

**Memory Snapshot**:
1. Click "Take Memory Snapshot" in the Memory tab
2. Browse types sorted by size or count
3. Click a type to inspect individual objects
4. Expand objects to see fields, values, and GC roots

**CPU Trace**:
1. Select trace duration (3-30 seconds)
2. Click "Take CPU Trace"
3. Review hot functions sorted by CPU time
4. Click "Open in Speedscope" for flame graph visualization

### Using AI Analysis

1. Expand the "AI Analysis (Copilot)" panel
2. Take a memory snapshot or CPU trace first
3. Use quick suggestions or type your own question
4. AI will analyze the data in context of your codebase

## Extension Settings

This extension contributes the following commands:

- `dotnet-profiler.startMonitoring` - Start monitoring a .NET process
- `dotnet-profiler.stopMonitoring` - Stop the current monitoring session

## Known Issues

- CPU traces require the target process to be running during capture
- Very large heap dumps may take time to analyze
- Speedscope integration requires a web browser

## Release Notes

### 0.0.1

Initial release:
- Real-time CPU and memory monitoring
- GC heap snapshots with object inspection
- CPU tracing with Speedscope export
- AI-powered analysis via GitHub Copilot
- Automatic .NET tool installation

## License

MIT

## Contributing

Contributions welcome! Please open issues and pull requests at [GitHub](https://github.com/ghostbust555/dotnetprofilerforvscode).
