# AWS EC2 deployment

For the fastest hackathon deployment, launch one Ubuntu 24.04 EC2 instance with:

- Instance type: `t3.micro` for new-account Free Tier eligibility
- Root volume: 30 GB gp3
- Inbound rule: TCP 80 from `0.0.0.0/0`
- No public database or internal service ports
- User data: the contents of `ec2-user-data.sh`

Alternatively, create a CloudFormation stack by uploading `cloudformation.yaml`. It provisions the instance, security group, disk, and bootstrap in one operation.

The bootstrap adds 4 GB of swap for the memory-constrained Free Tier instance, then installs Node.js 22, Python, Java 21, Docker, PostgreSQL, Nginx, RelayGrid, and all application dependencies. It generates deployment credentials on the instance and exposes only the Console through Nginx.

Use EC2 Instance Connect or Session Manager to read `/root/relaygrid-deployment.txt` after cloud-init completes. Never add model API keys to user data or Git. Configure the TrueForge model through a private SSH tunnel, then run `npm run trueforge:bootstrap` on the instance.

Stop or terminate the instance after the event to avoid ongoing compute, storage, and public IPv4 charges.
