bucket_name = "grove-staging-games"

# One box per region. Three regions because a region is the unit of failure a player notices, and
# because `@grove/server-manager` treats a requested region as a filter rather than a preference —
# a region with no box in it is a region no player can be placed in.
fleet = {
  a = {
    region                = "us-east-1"
    vpc_cidr              = "10.10.0.0/16"
    instance_type         = "t3.small"
    instance_count        = 1
    max_instances_per_box = 2
  }
  b = {
    region                = "us-west-2"
    vpc_cidr              = "10.11.0.0/16"
    instance_type         = "t3.small"
    instance_count        = 1
    max_instances_per_box = 2
  }
  c = {
    region                = "us-east-2"
    vpc_cidr              = "10.12.0.0/16"
    instance_type         = "t3.small"
    instance_count        = 1
    max_instances_per_box = 2
  }
}

server_manager_url = "http://server-manager.staging.grove.internal:4003"
