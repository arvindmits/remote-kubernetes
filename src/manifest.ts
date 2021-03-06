import {promises} from 'fs';
import * as yaml from 'yaml';
import * as path from 'path';
import * as vscode from 'vscode';

export class Manifest {
    constructor(public name: string, public namespace: string, public workdir: string) {}
}

export async function getManifest(manifestPath: string): Promise<Manifest> {
    const data = await promises.readFile(manifestPath, {encoding: 'utf8'});
    if (!data) {
        throw new Error(`${manifestPath} is not a valid Okteto manifest`);
    }

    const parsed = yaml.parseDocument(data);
    if (parsed.errors && parsed.errors.length > 0) {
        console.error(`${manifestPath} is not a valid yaml file: ${parsed.errors.join(", ")}`);
        throw new Error(`${manifestPath} is not a valid yaml file`);
    }

    const j = parsed.toJSON();
    const m = new Manifest(j.name, j.namespace, j.workdir);
    if (!m.name){
        throw new Error(`${manifestPath} is not a valid Okteto manifest`);
    }

    return m;
}

export function getDefaultLocation(): vscode.Uri | undefined{
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return undefined;
    }

    const p = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'okteto.yml');
    const loc = vscode.Uri.file(p);
    console.log(`default location: ${loc.fsPath.toString()}`);
    return loc;

}
