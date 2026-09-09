# A creator's upload landing in `sources/` is what queues a build. The rule is the only thing that
# makes that happen, so a build is never triggered by the uploading client asking for one — a client
# that forgot to ask would leave a game published and never compiled.

locals {
  name = "grove-${var.environment}-game-builds"
}

resource "aws_sqs_queue" "builds_dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = merge(var.tags, { Name = "${local.name}-dlq" })
}

resource "aws_sqs_queue" "builds" {
  name                       = local.name
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  sqs_managed_sse_enabled    = true

  # A build that fails the same way three times fails on its source, not on the machine that took
  # it, and redelivering it forever would hide that behind a queue that never drains.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.builds_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.tags, { Name = local.name })
}

resource "aws_cloudwatch_event_rule" "source_uploaded" {
  name        = "grove-${var.environment}-source-uploaded"
  description = "A creator's source archive landed in the ${var.environment} games bucket"

  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = { name = [var.bucket_name] }
      object = { key = [{ prefix = var.source_prefix }] }
    }
  })

  tags = merge(var.tags, { Name = "grove-${var.environment}-source-uploaded" })
}

resource "aws_cloudwatch_event_target" "builds" {
  rule = aws_cloudwatch_event_rule.source_uploaded.name
  arn  = aws_sqs_queue.builds.arn

  # An event EventBridge could not put on the queue is kept rather than dropped: the upload it
  # describes is already stored, and losing the event is a game that is never compiled.
  dead_letter_config {
    arn = aws_sqs_queue.builds_dlq.arn
  }
}

data "aws_iam_policy_document" "builds" {
  statement {
    sid       = "AllowEventBridgeSend"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.builds.arn, aws_sqs_queue.builds_dlq.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.source_uploaded.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "builds" {
  queue_url = aws_sqs_queue.builds.id
  policy    = data.aws_iam_policy_document.builds.json
}

resource "aws_sqs_queue_policy" "builds_dlq" {
  queue_url = aws_sqs_queue.builds_dlq.id
  policy    = data.aws_iam_policy_document.builds.json
}

# One message here is one game that was published and never built, which no other signal reports.
resource "aws_cloudwatch_metric_alarm" "builds_dead_lettered" {
  alarm_name          = "${local.name}-dead-lettered"
  alarm_description   = "A build in ${var.environment} exhausted its deliveries or could not be queued"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.builds_dlq.name
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = merge(var.tags, { Name = "${local.name}-dead-lettered" })
}
