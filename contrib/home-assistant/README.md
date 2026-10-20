# Home Assistant: clear the FoxESS Cloud schedule every night

Solar Dash's battery overrides use FoxESS Cloud scheduler segments, and those
**repeat every day** until something removes them. This optional add-on turns the
FoxESS scheduler off at midnight from Home Assistant, so an override can never
carry over to the next day (for example, if the TV was off when it ended).

It only touches the FoxESS Cloud scheduler. Integrations that control the
inverter locally over Modbus (e.g. `foxess_modbus`, PowerSync) don't use
scheduler segments and aren't affected. If you rely on your own FoxESS app
schedule, this will switch it off every night, so don't install it.

## Install

1. Copy `foxess_cloud/` into your HA config folder (`/config/foxess_cloud/`).
2. Add the shell command, either by merging `shell_commands/foxess_cloud.yaml`
   into your `shell_command:` config or by putting it in your
   `!include_dir_merge_named` folder.
3. Add `automations/foxess_cloud_schedule.yaml` to your automations.
4. Add to `secrets.yaml`:

```yaml
foxess_cloud_api_key: "your FoxESS Open API key"
foxess_cloud_sn: "your inverter serial number"
```

5. Restart Home Assistant (shell commands aren't reloadable).

Test without changing anything:

```bash
docker exec home-assistant python3 /config/foxess_cloud/clear_schedule.py --check
```
