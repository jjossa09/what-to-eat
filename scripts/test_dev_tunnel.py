"""Targeted tunnel cleanup tests. Uses synthetic config.fixture, never any .env file."""

import os
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

URL = b'https://synthetic-test.trycloudflare.com'


class TunnelCleanup(unittest.TestCase):
    def run_tunnel(self, original, during=None):
        with tempfile.TemporaryDirectory(prefix='wte75-tunnel-') as directory:
            root = Path(directory)
            fixture = root / 'config.fixture'
            fixture.write_bytes(original)
            source = (Path(__file__).parent / 'dev-tunnel.sh').read_text()
            source = '\n'.join(f'ENV_FILE="{fixture}"' if line.startswith('ENV_FILE=') else line
                               for line in source.splitlines()) + '\n'
            script = root / 'tunnel.sh'
            script.write_text(source)
            provider = root / 'cloudflared'
            provider.write_text('#!/bin/sh\necho https://synthetic-test.trycloudflare.com\n'
                                'exec sleep 20\n')
            provider.chmod(0o700)
            process = subprocess.Popen(['bash', str(script)], env={**os.environ,
                'PATH': str(root) + os.pathsep + os.environ['PATH']},
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                for _ in range(100):
                    if URL in fixture.read_bytes():
                        break
                    if process.poll() is not None:
                        self.fail('Tunnel stopped before updating the synthetic public URL')
                    time.sleep(.02)
                self.assertIn(URL, fixture.read_bytes())
                if during:
                    fixture.write_bytes(during(fixture.read_bytes()))
                process.send_signal(signal.SIGTERM)
                output, error = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 143, (output, error))
                return fixture.read_bytes()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=3)

    def test_restores_original_lf_bytes(self):
        original = b'PUBLIC_FIXTURE=one\nEXPO_PUBLIC_API_URL=http://localhost:8000\nOTHER_FIXTURE=two\n'
        self.assertEqual(self.run_tunnel(original), original)

    def test_restores_original_crlf_bytes(self):
        original = b'PUBLIC_FIXTURE=one\r\nEXPO_PUBLIC_API_URL=http://localhost:8000\r\nOTHER_FIXTURE=two\r\n'
        self.assertEqual(self.run_tunnel(original), original)

    def test_preserves_user_changes_to_other_settings(self):
        original = b'EXPO_PUBLIC_API_URL=http://localhost:8000\nOTHER_FIXTURE=one\n'
        actual = self.run_tunnel(original, lambda data:
                                 data.replace(b'OTHER_FIXTURE=one', b'OTHER_FIXTURE=two'))
        self.assertEqual(actual, original.replace(b'OTHER_FIXTURE=one', b'OTHER_FIXTURE=two'))

    def test_preserves_a_url_changed_by_the_user(self):
        original = b'EXPO_PUBLIC_API_URL=http://localhost:8000\n'
        actual = self.run_tunnel(original, lambda data: data.replace(URL, b'https://synthetic-user.invalid'))
        self.assertEqual(actual, b'EXPO_PUBLIC_API_URL=https://synthetic-user.invalid\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
