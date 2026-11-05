"""Review, prepare and deploy one CPU Basic Space; never purchases a subscription.

Use a dedicated Python 3.11 environment with deployment/requirements.txt.
Authenticate with `hf auth login`; no token command-line argument is accepted.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ('Dockerfile', 'requirements-api.txt', 'requirements-cpu.txt', '__init__.py',
         'api.py', 'settings.py', 'store.py', 'worker.py', '.dockerignore')


def validate_existing_space(info, runtime):
    """Refuse to overwrite a Space outside this single-instance CPU proposal.

    huggingface_hub 2.4.0 exposes hardware, requested_hardware, storage and
    volumes on SpaceRuntime. Replica counts remain in its raw response. An
    unknown replica schema is deliberately rejected rather than assumed safe.
    """
    if getattr(info, 'private', None) is not False:
        raise RuntimeError('The existing Space is private or its visibility is unknown; choose a separate public Space.')
    if getattr(info, 'sdk', None) != 'docker':
        raise RuntimeError('The existing Space is not a Docker service; choose a separate Space name.')
    hardware = getattr(runtime, 'hardware', None)
    if getattr(hardware, 'value', hardware) != 'cpu-basic':
        raise RuntimeError('The existing Space uses different or unknown hardware; review it before changing anything.')
    requested = getattr(runtime, 'requested_hardware', None)
    if getattr(requested, 'value', requested) not in (None, 'cpu-basic'):
        raise RuntimeError('The existing Space has a different hardware request pending; review it before changing anything.')
    raw = getattr(runtime, 'raw', None)
    replicas = raw.get('replicas') if isinstance(raw, dict) else None
    if not isinstance(replicas, dict) or any(type(replicas.get(key)) is not int or replicas[key] != 1 for key in ('current', 'requested')):
        raise RuntimeError('The existing Space must report exactly one current and requested replica; unknown or scaled configurations are not reused.')
    # Any attached storage is outside this ephemeral, local-SQLite proposal.
    if (getattr(runtime, 'storage', None) is not None or raw.get('storage') is not None or
            getattr(runtime, 'volumes', None) not in (None, []) or raw.get('volumes') not in (None, [])):
        raise RuntimeError('The existing Space has attached volumes or storage; choose a fresh Space without storage attachments.')


def prepare(destination):
    destination.mkdir(parents=True, exist_ok=False)
    for name in FILES:
        shutil.copy2(ROOT / 'backend' / name, destination / name)
    (destination / 'README.md').write_text('''---
title: Duowen WhisperX
emoji: 🎙️
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
---

Duowen's WhisperX transcription service. Audio is decoded and processed by
WhisperX; each visitor owns a private job capability. CPU Basic, one replica,
one ASGI worker. Input media is removed after processing. Results are retained
for up to 24 hours in the container's SQLite database. Space storage is ephemeral:
a container replacement can interrupt tasks or remove server-side results.
The frontend saves completed transcripts in the visitor's browser.
''', encoding='utf-8')
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'check', 'deploy', 'status'])
    parser.add_argument('--space-name', default='duowen-whisperx')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        output = args.output or Path(tempfile.mkdtemp(prefix='duowen-space-parent-')) / 'space'
        print(json.dumps({'preparedDirectory': str(prepare(output)), 'files': list(FILES) + ['README.md']}))
        return
    from huggingface_hub import HfApi
    from huggingface_hub.errors import RepositoryNotFoundError
    api = HfApi()  # The Hub's normal local credential store, never frontend config.
    account = api.whoami(cache=True)
    name = account.get('name')
    if not name:
        raise RuntimeError('The active Hugging Face account could not be verified.')
    repo_id = name + '/' + args.space_name
    if args.command == 'check':
        print(json.dumps({'account': name, 'isPro': account.get('isPro') is True,
                          'space': repo_id, 'hardware': 'cpu-basic',
                          'computeHourlyUSD': 0, 'proSubscriptionUSDPerMonth': 9}))
        return
    if args.command == 'status':
        info = api.space_info(repo_id)
        runtime = api.get_space_runtime(repo_id)
        print(json.dumps({'space': repo_id, 'stage': str(runtime.stage),
                          'hardware': getattr(runtime.hardware, 'value', runtime.hardware), 'host': info.host}))
        return
    # --deploy never upgrades an account or purchases hourly hardware.
    if account.get('isPro') is not True:
        raise RuntimeError('The approved PRO setup must be completed by the owner before deployment.')
    created = False
    try:
        info = api.space_info(repo_id)
        runtime = api.get_space_runtime(repo_id)
        validate_existing_space(info, runtime)
    except RepositoryNotFoundError:
        api.create_repo(repo_id=repo_id, repo_type='space', space_sdk='docker',
                        space_hardware='cpu-basic', visibility='public', exist_ok=False)
        created = True
    for key, value in {'DUOWEN_ALLOWED_ORIGINS': 'https://toooonyliu.github.io',
                       'DUOWEN_WHISPER_MODEL': 'base', 'DUOWEN_BATCH_SIZE': '1',
                       'DUOWEN_DEVICE': 'cpu', 'DUOWEN_COMPUTE_TYPE': 'int8',
                       'DUOWEN_DATA_DIR': '/data/duowen'}.items():
        api.add_space_variable(repo_id=repo_id, key=key, value=value)
    # A separate, optional read-only inference token must already be owner-supplied.
    # Never copy the deployment credential into the running application.
    inference_token = os.getenv('DUOWEN_INFERENCE_HF_TOKEN')
    if inference_token:
        api.add_space_secret(repo_id=repo_id, key='HF_TOKEN', value=inference_token)
        api.add_space_variable(repo_id=repo_id, key='DUOWEN_DIARIZE', value='1')
    elif created:
        api.add_space_variable(repo_id=repo_id, key='DUOWEN_DIARIZE', value='0')
    # Reusing a Space without a new token must preserve its existing diarization
    # setting and runtime secret, including secrets configured through the UI.
    with tempfile.TemporaryDirectory(prefix='duowen-space-') as temporary:
        context = prepare(Path(temporary) / 'context')
        api.upload_folder(repo_id=repo_id, repo_type='space', folder_path=str(context),
                          allow_patterns=list(FILES) + ['README.md'],
                          commit_message='Deploy Duowen WhisperX CPU service')
    info = api.space_info(repo_id)
    runtime = api.get_space_runtime(repo_id)
    print(json.dumps({'space': repo_id, 'host': info.host, 'stage': str(runtime.stage),
                      'hardwareRequested': 'cpu-basic',
                      'diarizationEnabled': True if inference_token else False if created else None,
                      'diarizationSetting': 'enabled' if inference_token else 'default-off' if created else 'preserved'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SDK exception bodies can contain account/auth context; keep output bounded.
        status = getattr(getattr(error, 'response', None), 'status_code', None)
        if isinstance(error, RuntimeError):
            print(json.dumps({'error': str(error)}))
        else:
            print(json.dumps({'error': type(error).__name__, 'httpStatus': status,
                              'nextStep': 'Check the active Hugging Face login, PRO plan and Space permissions.'}))
        raise SystemExit(1)
