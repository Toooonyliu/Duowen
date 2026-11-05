"""Offline regression checks for reusing a Space; no Hub SDK/login is loaded."""
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('duowen_huggingface_deploy', Path(__file__).resolve().parents[1] / 'huggingface.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class RepositoryNotFoundError(Exception):
    pass


class ExistingSpaceAPI:
    def __init__(self):
        self.info = SimpleNamespace(private=False, sdk='docker', host='https://offline-fixture.invalid')
        self.runtime = SimpleNamespace(hardware='cpu-basic', requested_hardware='cpu-basic',
                                       storage=None, volumes=None, stage='RUNNING',
                                       raw={'replicas': {'current': 1, 'requested': 1}, 'storage': None, 'volumes': []})
        self.mutations = []
        self.variables = {'DUOWEN_DIARIZE': '1'}

    def whoami(self, **kwargs):
        return {'name': 'offline-owner', 'isPro': True}

    def space_info(self, repo_id):
        return self.info

    def get_space_runtime(self, repo_id):
        return self.runtime

    def create_repo(self, **kwargs):
        self.mutations.append(('create', kwargs))

    def add_space_variable(self, **kwargs):
        self.mutations.append(('variable', kwargs))
        self.variables[kwargs['key']] = kwargs['value']

    def add_space_secret(self, **kwargs):
        self.mutations.append(('secret', kwargs))

    def upload_folder(self, **kwargs):
        self.mutations.append(('upload', kwargs))


def deploy_offline(api, inference_token=None):
    hub = ModuleType('huggingface_hub')
    hub.HfApi = lambda: api
    errors = ModuleType('huggingface_hub.errors')
    errors.RepositoryNotFoundError = RepositoryNotFoundError
    # Clearing the environment also prevents any accidentally inherited real token
    # from affecting this test. All API methods above are local Python objects.
    environment = {'DUOWEN_INFERENCE_HF_TOKEN': inference_token} if inference_token else {}
    output = io.StringIO()
    with patch.dict(sys.modules, {'huggingface_hub': hub, 'huggingface_hub.errors': errors}), \
            patch.dict(os.environ, environment, clear=True), \
            patch.object(sys, 'argv', ['huggingface.py', 'deploy']), \
            patch.object(deployment, 'prepare', side_effect=lambda path: path), \
            redirect_stdout(output):
        deployment.main()
    return json.loads(output.getvalue())


class ExistingSpaceSafetyTests(unittest.TestCase):
    def test_unsafe_or_unknown_reuse_configuration_fails_before_any_mutation(self):
        cases = [
            ('private', 'info', 'private', True),
            ('visibility unknown', 'info', 'private', None),
            ('different SDK', 'info', 'sdk', 'gradio'),
            ('paid current hardware', 'runtime', 'hardware', 'cpu-upgrade'),
            ('current hardware unknown', 'runtime', 'hardware', None),
            ('pending paid hardware', 'runtime', 'requested_hardware', 't4-small'),
            ('current replicas scaled', 'raw', 'replicas', {'current': 2, 'requested': 1}),
            ('pending replicas scaled', 'raw', 'replicas', {'current': 1, 'requested': 2}),
            ('zero active replicas', 'raw', 'replicas', {'current': 0, 'requested': 1}),
            ('replicas missing', 'raw', 'replicas', None),
            ('replica schema unknown', 'raw', 'replicas', 1),
            ('replica type is not integer', 'raw', 'replicas', {'current': True, 'requested': 1}),
            ('legacy storage', 'runtime', 'storage', 'small'),
            ('storage only in raw', 'raw', 'storage', 'small'),
            ('bucket volume', 'runtime', 'volumes', [SimpleNamespace(type='bucket', mount_path='/data')]),
            ('volume only in raw', 'raw', 'volumes', [{'type': 'bucket', 'mount_path': '/data'}]),
        ]
        for label, target, key, value in cases:
            with self.subTest(label=label):
                api = ExistingSpaceAPI()
                if target == 'raw':
                    api.runtime.raw[key] = copy.deepcopy(value)
                else:
                    setattr(getattr(api, target), key, value)
                with self.assertRaises(RuntimeError):
                    deploy_offline(api)
                self.assertEqual(api.mutations, [])

    def test_redeploy_without_new_token_preserves_existing_diarization_setting(self):
        for setting in ('0', '1'):
            with self.subTest(setting=setting):
                api = ExistingSpaceAPI()
                api.variables['DUOWEN_DIARIZE'] = setting
                # None is a documented valid value when no hardware change was requested.
                api.runtime.requested_hardware = None
                outcome = deploy_offline(api)
                self.assertEqual(api.variables['DUOWEN_DIARIZE'], setting)
                self.assertFalse(any(kind == 'secret' or kind == 'variable' and payload['key'] == 'DUOWEN_DIARIZE' for kind, payload in api.mutations))
                self.assertEqual(outcome['diarizationSetting'], 'preserved')
                self.assertIsNone(outcome['diarizationEnabled'])
                self.assertEqual(sum(kind == 'upload' for kind, _ in api.mutations), 1)
                self.assertFalse(any(kind == 'create' for kind, _ in api.mutations))

    def test_redeploy_with_explicit_new_token_enables_diarization_after_saving_secret(self):
        api = ExistingSpaceAPI()
        api.variables['DUOWEN_DIARIZE'] = '0'
        outcome = deploy_offline(api, inference_token='offline-fixture-not-a-real-token')
        secret_index = next(index for index, (kind, _) in enumerate(api.mutations) if kind == 'secret')
        enable_index = next(index for index, (kind, payload) in enumerate(api.mutations) if kind == 'variable' and payload['key'] == 'DUOWEN_DIARIZE')
        self.assertLess(secret_index, enable_index)
        self.assertEqual(api.variables['DUOWEN_DIARIZE'], '1')
        self.assertTrue(outcome['diarizationEnabled'])
        self.assertEqual(outcome['diarizationSetting'], 'enabled')


if __name__ == '__main__':
    unittest.main()
