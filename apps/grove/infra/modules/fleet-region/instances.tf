data "aws_ssm_parameter" "ami" {
  name = var.ami_ssm_parameter
}

resource "aws_launch_template" "fleet" {
  name_prefix   = "${local.name}-"
  image_id      = data.aws_ssm_parameter.ami.insecure_value
  instance_type = var.instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.fleet.arn
  }

  vpc_security_group_ids = [aws_security_group.fleet.id]

  # IMDSv2 only, one hop: the agent reads this box's instance id for `HOST_ID`, and a single hop
  # keeps that credential out of reach of anything the box later runs in a container.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_endpoint               = "enabled"
  }

  monitoring {
    enabled = true
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.root_volume_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    region                = var.region
    grove_env             = var.environment == "production" ? "production" : "development"
    secret_path           = local.secret_path
    server_manager_url    = var.server_manager_url
    instance_manager_port = var.instance_manager_port
    max_instances         = var.max_instances_per_box
    heartbeat_interval    = var.heartbeat_interval
    agent_bin             = "/opt/grove/bin/instance-manager"
    game_instance_bin     = "/opt/grove/bin/grove-game-instance"
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = local.name })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = local.name })
  }

  tags = merge(var.tags, { Name = local.name })

  # A launch template is replaced, never edited in place, and the group must be pointed at the new
  # version before the old one goes.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "fleet" {
  name_prefix         = "${local.name}-"
  vpc_zone_identifier = aws_subnet.fleet[*].id

  min_size         = var.instance_count
  max_size         = coalesce(var.max_instance_count, var.instance_count)
  desired_capacity = var.instance_count

  # EC2 health only. An unhealthy agent is a fact `@grove/server-manager` already routes on by
  # withholding work from the box, and replacing the box instead would end every session on it.
  health_check_type         = "EC2"
  health_check_grace_period = 300

  # Rebalancing terminates a box to even out the zones, and a terminated box is every session it was
  # holding, gone.
  suspended_processes = ["AZRebalance"]

  launch_template {
    id      = aws_launch_template.fleet.id
    version = aws_launch_template.fleet.latest_version
  }

  # Deliberately no `instance_refresh`: a new launch template version is picked up by the next box
  # this group launches, and rolling the existing ones is an operator's call made when the sessions
  # on them can be drained.

  dynamic "tag" {
    for_each = merge(var.tags, { Name = local.name })

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}
