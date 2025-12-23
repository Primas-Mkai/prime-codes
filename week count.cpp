#include <iostream>
#include <ctime>
using namespace std;

int main() {
	time_t now;
	time_t certainDay;
	struct tm datetime;
	
	int year, mon, mday, hour, min, sec;
	
	cout << "Year: ";
	cin >> year;
	cout << "Month: "; 
	cin >> mon; // o is january
	cout << "Day of the month: ";
	cin >> mday; 
	cout << "Hour: ";
	cin >> hour; // input in 24 hours system
	cout << "Minutes: ";
	cin >> min; 
	cout << "Seconds: ";
	cin >> sec;
	
	now = time(NULL);
	datetime = *localtime(&now);
	datetime.tm_year = year - 1900;
	datetime.tm_mon = mon;
	datetime.tm_mday = mday;
	datetime.tm_hour = hour; datetime.tm_min = min; datetime.tm_sec = sec;
	datetime.tm_isdst = -1;
	certainDay = mktime(&datetime);
	
	cout << ctime(&certainDay) << endl;
	
	int diff = difftime(now, certainDay);
	
	int number_of_weeks;
	
	number_of_weeks = diff / 604800;
	
	cout << "The number of weeks is: " << number_of_weeks;
	
	return 0;
}