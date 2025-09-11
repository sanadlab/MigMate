import { TelemetryReporter } from "@vscode/extension-telemetry";



class TelemetryService {
    private reporter: TelemetryReporter | undefined;

    public initialize(reporter: TelemetryReporter) {
        this.reporter = reporter;
    }

    public sendTelemetryEvent(eventName: string, properties?: { [key: string]: string }, measurements?: { [key: string]: number }) {
        this.reporter?.sendTelemetryEvent(eventName, properties, measurements);
    }

    public sendTelemetryErrorEvent(eventName: string, properties?: { [key: string]: string }, measurements?: { [key: string]: number }) {
        this.reporter?.sendTelemetryErrorEvent(eventName, properties, measurements);
    }

    public sendCliEvent(command: string, duration: number) { // check this to see if necessary, and if duration works
        this.reporter?.sendTelemetryEvent('cliCommand', { command }, { duration });
    }
}

export const telemetryService = new TelemetryService();
