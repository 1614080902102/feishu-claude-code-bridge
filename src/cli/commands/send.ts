import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Client, Domain } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../../config/schema';
import { isComplete } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { loadConfig } from '../../config/store';

/**
 * One-shot CLI: upload a file/image with the bot's credentials and post
 * it into a chat. Intended for Claude (running inside a bridge session) to
 * invoke via Bash — `chat_id` comes from the `bridge_context` block, and
 * the bot is whatever the bridge is bound to, so this never touches a
 * different app's identity.
 */

interface SendOpts {
  chatId: string;
  path: string;
  name?: string;
}

type FileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

const FILE_TYPE_BY_EXT: Record<string, FileType> = {
  '.opus': 'opus',
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

export async function runSendFile(opts: SendOpts): Promise<void> {
  const client = await buildClient();
  const filename = opts.name ?? basename(opts.path);
  const ext = extname(filename).toLowerCase();
  const fileType: FileType = FILE_TYPE_BY_EXT[ext] ?? 'stream';

  await assertReadable(opts.path);
  const buf = await readFile(opts.path);

  let upload: { file_key?: string } | null = null;
  try {
    upload = (await client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: filename,
        file: buf,
      },
    })) as { file_key?: string } | null;
  } catch (err) {
    fail(`上传文件失败：${describeThrown(err)}`);
  }

  const fileKey = upload?.file_key;
  if (!fileKey) {
    fail(`上传文件失败：响应里没有 file_key (resp=${JSON.stringify(upload)})`);
  }

  const msgId = await sendMessage(client, opts.chatId, 'file', { file_key: fileKey });
  console.log(JSON.stringify({ ok: true, message_id: msgId, file_key: fileKey }));
}

export async function runSendImage(opts: SendOpts): Promise<void> {
  const client = await buildClient();
  await assertReadable(opts.path);
  const buf = await readFile(opts.path);

  let upload: { image_key?: string } | null = null;
  try {
    upload = (await client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: buf,
      },
    })) as { image_key?: string } | null;
  } catch (err) {
    fail(`上传图片失败：${describeThrown(err)}`);
  }
  const imageKey = upload?.image_key;
  if (!imageKey) {
    fail(`上传图片失败：响应里没有 image_key (resp=${JSON.stringify(upload)})`);
  }

  const msgId = await sendMessage(client, opts.chatId, 'image', { image_key: imageKey });
  console.log(JSON.stringify({ ok: true, message_id: msgId, image_key: imageKey }));
}

async function sendMessage(
  client: Client,
  chatId: string,
  msgType: 'file' | 'image',
  content: Record<string, string>,
): Promise<string> {
  let resp: { code?: number; msg?: string; data?: { message_id?: string } } | null = null;
  try {
    resp = (await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
      },
    })) as { code?: number; msg?: string; data?: { message_id?: string } } | null;
  } catch (err) {
    fail(`发送消息失败：${describeThrown(err)}`);
  }
  if (resp?.code && resp.code !== 0) {
    fail(`发送消息失败：code=${resp.code} msg=${resp.msg ?? '<no msg>'}`);
  }
  const id = resp?.data?.message_id;
  if (!id) fail(`发送消息失败：响应里没有 message_id (resp=${JSON.stringify(resp)})`);
  return id;
}

async function buildClient(): Promise<Client> {
  const partial = await loadConfig();
  if (!isComplete(partial)) {
    fail('bridge 未配置（~/.lark-channel/config.json 缺 app 凭证）');
  }
  const cfg: AppConfig = partial;
  const appSecret = await resolveAppSecret(cfg);
  return new Client({
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
  });
}

async function assertReadable(path: string): Promise<void> {
  try {
    const st = await stat(path);
    if (!st.isFile()) fail(`不是普通文件：${path}`);
  } catch (err) {
    fail(`读取文件失败：${(err as Error).message}`);
  }
}

function describeThrown(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as {
    response?: { data?: { code?: number; msg?: string }; status?: number };
    message?: string;
  };
  const body = e.response?.data;
  if (body && (body.code !== undefined || body.msg)) {
    return `code=${body.code ?? '?'} msg=${body.msg ?? '<no msg>'}`;
  }
  if (e.response?.status) return `HTTP ${e.response.status}`;
  return e.message ?? String(err);
}

function fail(reason: string): never {
  console.error(`✗ ${reason}`);
  process.exit(1);
}
