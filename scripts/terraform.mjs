// `terraform <task>` in the calling package, or a clear skip when there is no Terraform here.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'terraform',
    probe: ['version'],
    install: 'Install Terraform (https://developer.hashicorp.com/terraform/install)',
});
