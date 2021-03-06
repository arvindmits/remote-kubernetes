'use strict';

import * as fs from 'fs';
import {promises} from 'fs';
import * as execa from 'execa';
import * as path from 'path';
import * as commandExists from 'command-exists';
import {protect} from './machineid';
import * as vscode from 'vscode';
import * as os from 'os';
import * as download from 'download';
import * as semver from 'semver';
import {pascalCase} from 'change-case';
import * as paths from './paths';


const oktetoFolder = '.okteto';
const stateFile = 'okteto.state';
const minimum = '1.8.2';

export const terminalName = `okteto`;

export const state = {
  starting: 'starting',
  activating: 'activating',
  attaching: 'attaching',
  pulling: 'pulling',
  startingSync: 'startingSync',
  synchronizing: 'synchronizing',
  ready: 'ready',
  unknown: 'unknown',
  failed: 'failed',
};

export async function needsInstall(): Promise<{install: boolean, upgrade: boolean}>{
  const binary = getBinary();

  const installed = await isInstalled(binary);
  if (!installed) {
    return {install: true, upgrade: false};
  }


  try {
    const version =  await getVersion(binary);
    if (!version) {
      return {install: false, upgrade: false};
    }
    return {install: semver.lt(version, minimum), upgrade: true};
  } catch {
    return {install: false, upgrade: false};
  }
}

async function isInstalled(binaryPath: string): Promise<boolean> {
  try {
    if (path.isAbsolute(binaryPath)) {
      await promises.access(binaryPath);
    } else {
      await commandExists(binaryPath);
    }

    return true;
  } catch {
      return false;
  }
}

async function getVersion(binary: string): Promise<string | undefined> {
  const r = await execa.command(`${binary} version`);
  if (r.failed) {
    console.error(`okteto version failed: ${r.stdout} ${r.stderr}`);
    return undefined;
  }

  const version = r.stdout.replace('okteto version ', '').trim();
  if (semver.valid(version)) {
    return version;
  }

  return undefined;
}

export async function install() {
  let source = '';
  let chmod = true;

  switch(os.platform()){
    case 'win32':
      source = 'https://github.com/okteto/okteto/releases/latest/download/okteto.exe';
      chmod = false;
      break;
    case 'darwin':
      source = 'https://github.com/okteto/okteto/releases/latest/download/okteto-Darwin-x86_64';
      break;
    default:
        source = 'https://github.com/okteto/okteto/releases/latest/download/okteto-Linux-x86_64';
  }

  let destination = getInstallPath();
  try {
    await promises.mkdir(path.dirname(destination), 0o700);
  } catch(err) {
    console.log(`failed to create dir: ${err.message}`);
  }

  try {
    await downloadFile(source, destination);
    if (!chmod) {
      return;
    }

    const r = await execa.command(`chmod +x ${destination}`);
    if (r.failed) {
      console.error(`chmod +x ${destination} failed: ${r.stdout} ${r.stderr}`);
      throw new Error(`failed to set exec permissions; ${r.stdout}`);
    }
  } catch(err) {
    throw new Error(`failed to install okteto: ${err.message}`);
  }
}

function downloadFile(source: string, destination: string) {
  return new Promise<string>((resolve, reject) => {
    const st = fs.createWriteStream(destination);
    download(source).pipe(st);
    st.on('error', (err, body, response) =>  {
      reject(err);
      return;
    });

    st.on('finish', () => {
      resolve();
      return;
    });
  });
}

export function up(manifest: string, namespace: string, name: string, port: number, kubeconfig: string) {
  console.log(`okteto up ${manifest}`);
  disposeTerminal();
  cleanState(namespace, name);
  const term = vscode.window.createTerminal({
    name: terminalName,
    hideFromUser: false,
    cwd: path.dirname(manifest),
    env: {
      "OKTETO_AUTODEPLOY":"1",
      "OKTETO_ORIGIN":"vscode",
      "KUBECONFIG": kubeconfig,
    }
  });


  let binary = getBinary();
  if (gitBashMode()){
    console.log('using gitbash style paths');
    binary = paths.toGitBash(binary);
    manifest = paths.toGitBash(manifest);
  }

  const cmd = `${binary} up -f ${manifest} --remote ${port}`;
  console.log(cmd);
  term.sendText(cmd, true);
}

export async function down(manifest: string, namespace: string, kubeconfig: string) {
  console.log(`launching okteto down -f ${manifest}`);
  disposeTerminal();
  const cmd = `${getBinary()} down --file ${manifest} --namespace ${namespace}`;
  console.log(cmd);
  const r = await execa.command(cmd, {env: {"KUBECONFIG": kubeconfig}});
  if (r.failed) {
    console.error(`okteto down failed: ${r.stdout} ${r.stderr}`);
    throw new Error(r.stdout);
  }
}

export function getStateMessages(): Map<string, string> {
  const messages = new Map<string, string>();
  messages.set(state.starting, "Starting your development environment...");
  messages.set(state.activating, "Activating your development environment...");
  messages.set(state.attaching, "Attaching your persistent volume...");
  messages.set(state.pulling, "Pulling your image...");
  messages.set(state.startingSync, "Starting the file synchronization service...");
  messages.set(state.synchronizing, "Synchronizing your files...");
  messages.set(state.ready, "Your development environment is ready...");
  return messages;
}

function getStateFile(namespace: string, name:string): string {
  return path.join(os.homedir(), oktetoFolder, namespace, name, stateFile);
}

export async function getState(namespace: string, name: string): Promise<string> {
  const p = getStateFile(namespace, name);

  
  try{
    await promises.access(p);
  }catch (err) {
    console.log(`failed to read state file: ${err}`);
    return state.starting;
  }

  var c = state.activating;

  try {
    const buffer = await promises.readFile(p, {encoding: 'utf8'});
    c = buffer.toString();
  } catch(err) {
    console.error(`failed to open ${p}: ${err}`);
    return state.unknown;
  }

  switch(c) {
      case state.starting:
      case state.activating:
      case state.attaching:
      case state.pulling:
      case state.startingSync:
      case state.synchronizing:
      case state.ready:
      case state.failed:
        return c;
      default:
        console.error(`received unknown state: '${c}'`);
        return state.unknown;
  }
}

export async function notifyIfFailed(namespace: string, name:string, callback: (m: string) => void){
  const id = setInterval(async () => {
    const c = await getState(namespace, name);
    if (c === state.failed) {
      callback(`Okteto: Up command failed`);
      clearInterval(id);
    }
  }, 1000);
}

export function cleanState(namespace: string, name:string) {
  const p = getStateFile(namespace, name);

  try{
    fs.unlinkSync(p);
  }catch(err) {
    if (err.code !== 'ENOENT'){
      console.error(`failed to delete ${p}: ${err}`);
    }
  }
}

function getBinary(): string {
  let binary = vscode.workspace.getConfiguration('okteto').get<string>('binary');
  if (binary) {
    if (binary.trim().length > 0) {
      return binary;
    }
  }

  return getInstallPath();
}

function getInstallPath(): string {
  if (os.platform() === 'win32') {
    return path.join(os.homedir(), "AppData", "Local", "Programs", "okteto.exe");
  }

  return path.join(os.homedir(), '.okteto-vscode', 'okteto');
}

function disposeTerminal(){
  vscode.window.terminals.forEach((t) => {
    if (t.name === terminalName) {
      t.dispose();
    }
  });
}

export function showTerminal(){
  vscode.window.terminals.forEach((t) => {
    if (t.name === terminalName) {
      t.show();
    }
  });
}

export function getOktetoId(): {id: string, machineId: string} {
  const tokenFile =  path.join(os.homedir(), oktetoFolder, ".token.json");
  let oktetoId: string;
  let machineId: string;

  try {
    const c = fs.readFileSync(tokenFile, {encoding: 'utf8'});
    const token = JSON.parse(c);
    oktetoId = token.ID;
    machineId = token.MachineID;
  } catch(err) {
    console.error(`failed to open ${tokenFile}: ${err}`);
    oktetoId = "";
    machineId = "";
  }

  if (!machineId) {
    machineId = protect();

  }

  return {id: oktetoId, machineId: machineId};
}

export function getLanguages(): RuntimeItem[] {
  const items = new Array<RuntimeItem>();
  items.push(new RuntimeItem("Java", "Maven", "maven"));
  items.push(new RuntimeItem("Java", "Gradle", "gradle"));
  items.push(new RuntimeItem("Ruby", "", "ruby"));
  items.push(new RuntimeItem("Python", "", "python"));
  items.push(new RuntimeItem("Node", "", "javascript"));
  items.push(new RuntimeItem("Golang", "", "golang"));
  items.push(new RuntimeItem("CSharp", "", "csharp"));

  const sorted = items.sort((a, b)=>{
    if (a.label === b.label) {
      return 0;
    } else if (a.label > b.label) {
      return 1;
    } else {
      return -1;
    }
  });

  sorted.push(new RuntimeItem("Other", "", ""));
  return sorted;

}

export async function init(manifestPath: vscode.Uri, choice: string) {
  const r = await execa.command(`${getBinary()} init --overwrite --file=${manifestPath.fsPath}`, {
    cwd: path.dirname(manifestPath.fsPath),
    env: {
      "OKTETO_ORIGIN":"vscode",
      "OKTETO_LANGUAGE":choice
      }
    });

  if (r.failed) {
    console.log(`init command failed: ${r.stdout}, ${r.stderr}`);
    throw new Error(r.stdout);
  }
}

class RuntimeItem implements vscode.QuickPickItem {

	label: string;

	constructor(private l: string, public description: string, public value: string) {
		this.label = pascalCase(l);
	}
}

export function gitBashMode(): boolean {
  const config = vscode.workspace.getConfiguration('okteto');
  if (!config) {
    return false;
  }

  return config.get<boolean>('gitBash') || false;
}
