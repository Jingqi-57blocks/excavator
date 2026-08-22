package constant

type TableName string

func (t TableName) String() string {
	return string(t)
}

const (
	TbLeaveRequest TableName = "leave_request"
	TbLeaveBalance TableName = "leave_balance"
)
