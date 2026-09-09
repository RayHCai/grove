bucket_name = "grove-production-games"

# One box per region. Three regions because a region is the unit of failure a player notices, and
# because `@grove/server-manager` treats a requested region as a filter rather than a preference —
# a region with no box in it is a region no player can be placed in.
fleet = {
  a = {
    region                = "us-east-1"
    vpc_cidr              = "10.20.0.0/16"
    instance_type         = "m7i.large"
    instance_count        = 1
    max_instances_per_box = 8
    root_volume_gb        = 100
  }
  b = {
    region                = "us-west-2"
    vpc_cidr              = "10.21.0.0/16"
    instance_type         = "m7i.large"
    instance_count        = 1
    max_instances_per_box = 8
    root_volume_gb        = 100
  }
  c = {
    region                = "us-east-2"
    vpc_cidr              = "10.22.0.0/16"
    instance_type         = "m7i.large"
    instance_count        = 1
    max_instances_per_box = 8
    root_volume_gb        = 100
  }
}

server_manager_url = "http://server-manager.grove.internal:4003"
