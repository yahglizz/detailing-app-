-- Pin the search_path of the two trigger functions added in 0015 (advisor: function_search_path_mutable).
alter function enforce_detail_capacity() set search_path = public;
alter function booking_invoices_lock_paid() set search_path = public;
